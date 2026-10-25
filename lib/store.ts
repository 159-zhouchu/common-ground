import fs from 'node:fs';
import path from 'node:path';
import type { Store, Task, Connection, LegacyConnection, ConnectionTest } from './types';
import { MAX_CONNECTIONS, MAX_TASKS } from './limits';
import { isDeepStrictEqual } from 'node:util';
import { connectionInUse, taskInFlight } from './execution';
import { seed, now } from './seed';
import { AppError, requireIdle, current } from './domain';
import { writeAtomic } from './atomic-file';
import { jsonStore } from './json-store';
import { workspaceSummary } from './workspace-summary';
import { taskContent, type TaskContent } from './task-views';
import {
  readStoredJSON,
  ConnectionList,
  LegacyConnectionList,
  StoredConnectionTests,
} from './storage-validation';
export { writeAtomic } from './atomic-file';
// Local mutable state must never be bundled into a traced deployment artifact.
const root = path.resolve(/*turbopackIgnore: true*/ process.env.CG_DATA_DIR || '.data');
const file = path.join(root, 'workspace.json');
export function recoverWorkspace(s: Store) {
  let changed = false;
  for (const t of s.tasks)
    for (const r of t.runs)
      if (r.state === 'running') {
        changed = true;
        r.state = 'interrupted';
        r.error = '本机服务重启，运行已中断；请手动重试。已发出请求的费用仍待核对。';
        r.endedAt = now();
        for (const step of r.steps)
          if (step.status === 'running' || step.status === 'queued') step.status = 'cancelled';
      }
  return changed;
}
const workspace = jsonStore<Store>(
  file,
  seed,
  recoverWorkspace,
  (s) =>
    !!s &&
    s.version === 1 &&
    Array.isArray(s.tasks) &&
    [...s.tasks, ...(s.archivedTasks || [])].every(
      (t) =>
        !!t &&
        Array.isArray(t.revisions) &&
        Array.isArray(t.runs) &&
        Array.isArray(t.sources) &&
        Array.isArray(t.findings) &&
        Array.isArray(t.messages) &&
        Array.isArray(t.impacts) &&
        t.revisions.some((r) => r.id === t.currentRevision && Array.isArray(r.blocks)),
    ),
);
export function readStore(): Store {
  return workspace.read();
}
export const readWorkspaceSummary = () => workspace.read(workspaceSummary);
export const workspaceRevisionTag = () => workspace.revisionTag();
export function transact<T>(fn: (s: Store) => T): T {
  return workspace.transact(fn);
}
export function getTask(id: string) {
  const t = workspace.read((s) => s.tasks.find((t) => t.id === id));
  if (!t) throw new AppError('NOT_FOUND', '项目不存在', 404);
  return t;
}
export function getTaskContent(id: string, view: TaskContent['contentView']) {
  const result = workspace.read((s) => {
    const task = s.tasks.find((t) => t.id === id);
    return task ? taskContent(task, view) : undefined;
  });
  if (!result) throw new AppError('NOT_FOUND', '项目不存在', 404);
  return result;
}
export function getRunAudit(taskId: string, runId: string) {
  const run = workspace.read((s) =>
    s.tasks.find((t) => t.id === taskId)?.runs.find((r) => r.id === runId),
  );
  if (!run) throw new AppError('NOT_FOUND', '调用记录不存在', 404);
  return { run };
}
export function runPrimaryConnection(taskId: string, runId: string) {
  return workspace.read((s) => {
    const task = s.tasks.find((t) => t.id === taskId);
    if (!task) throw new AppError('NOT_FOUND', '项目不存在', 404);
    return task.runs.find((run) => run.id === runId)?.roleAssignments?.a;
  });
}
export function editTask<T>(id: string, fn: (t: Task) => T) {
  return transact((s) => {
    const t = s.tasks.find((t) => t.id === id);
    if (!t) throw new AppError('NOT_FOUND', '项目不存在', 404);
    const before = structuredClone(t);
    const r = fn(t);
    if (!isDeepStrictEqual(before, t))
      t.updatedAt = new Date(Math.max(Date.now(), Date.parse(before.updatedAt) + 1)).toISOString();
    return r;
  });
}
export function renameTask(id: string, title: string, base: string) {
  return editTask(id, (t) => {
    requireIdle(t);
    if (taskInFlight(id))
      throw new AppError('RUN_ACTIVE', '请等待已停止的请求结束后再管理项目。', 409);
    if (current(t).id !== base)
      throw new AppError('REVISION_CONFLICT', '项目已更新，请刷新后重试。', 409);
    t.title = title;
    return t;
  });
}
export function archiveTask(id: string, base: string) {
  return transact((s) => {
    const t = s.tasks.find((t) => t.id === id);
    if (!t) throw new AppError('NOT_FOUND', '项目不存在', 404);
    requireIdle(t);
    if (taskInFlight(id))
      throw new AppError('RUN_ACTIVE', '请等待已停止的请求结束后再管理项目。', 409);
    if (current(t).id !== base)
      throw new AppError('REVISION_CONFLICT', '项目已更新，请刷新后重试。', 409);
    (s.archivedTasks ??= []).push(t);
    s.tasks = s.tasks.filter((x) => x.id !== id);
    return { ok: true };
  });
}
export function restoreTask(id: string) {
  return transact((s) => {
    const t = s.archivedTasks?.find((t) => t.id === id);
    if (!t) throw new AppError('NOT_FOUND', '回收站项目不存在', 404);
    if (s.tasks.length >= MAX_TASKS)
      throw new AppError('TASK_LIMIT', '项目已达 50 个，请先移走其他项目。');
    if (s.tasks.some((x) => x.id === id))
      throw new AppError('TASK_CONFLICT', '项目标识已存在。', 409);
    s.tasks.push(t);
    s.archivedTasks = s.archivedTasks!.filter((x) => x.id !== id);
    return t;
  });
}
const defaultConnection = (slot: 'a' | 'b'): Connection => ({
  connectionId: 'legacy-' + slot,
  slot,
  enabled: true,
  createdAt: null,
  updatedAt: null,
  label: slot === 'a' ? '模型 A' : '模型 B',
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  protocol: 'responses',
  structured: true,
  inputPrice: null,
  outputPrice: null,
});
export function connections(): Connection[] {
  const p = path.join(root, 'connections.json');
  if (!fs.existsSync(p)) return [defaultConnection('a'), defaultConnection('b')];
  const raw = readStoredJSON<Connection[] | { version: 2; connections: Connection[] }>(
    p,
    (value): value is Connection[] | { version: 2; connections: Connection[] } =>
      ConnectionList.safeParse(value).success || LegacyConnectionList.safeParse(value).success,
  );
  if (!Array.isArray(raw)) return raw.connections;
  if (
    raw.some((c) => !c.slot || !['a', 'b'].includes(c.slot)) ||
    new Set(raw.map((c) => c.slot)).size !== raw.length
  )
    throw new AppError(
      'MIGRATION_INVALID',
      '旧连接配置格式无法确定；原文件未修改，请检查本机备份。',
    );
  const migrated: Connection[] = raw.map((c) => ({
    ...c,
    connectionId: 'legacy-' + c.slot,
    enabled: true,
    createdAt: null,
    updatedAt: null,
  }));
  const backup = path.join(root, 'backups', 'connections-v1.json');
  fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(backup)) fs.copyFileSync(p, backup, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') fs.chmodSync(backup, 0o600);
  writeAtomic(p, { version: 2, connections: migrated });
  return migrated;
}
export function saveConnections(input: (Connection | LegacyConnection)[]) {
  if (input.length > MAX_CONNECTIONS)
    throw new AppError('CONNECTION_LIMIT', `最多保存 ${MAX_CONNECTIONS} 个连接。`);
  const old = connections();
  const c: Connection[] = input.map((c) =>
    'connectionId' in c
      ? c
      : {
          ...c,
          connectionId: 'legacy-' + c.slot,
          enabled: true,
          createdAt: null,
          updatedAt: now(),
        },
  );
  if (new Set(c.map((x) => x.connectionId)).size !== c.length)
    throw new AppError('CONNECTION_DUPLICATE', '连接 ID 不能重复。');
  for (const previous of old)
    if (
      !c.some((x) => x.connectionId === previous.connectionId) &&
      connectionInUse(previous.connectionId)
    )
      throw new AppError(
        'CONNECTION_BUSY',
        '连接正在运行或测试中，暂不能删除；停止并等待请求结束后重试。',
        409,
      );
  writeAtomic(path.join(root, 'connections.json'), { version: 2, connections: c });
}
export function connectionTests(): ConnectionTest[] {
  const p = path.join(root, 'connection-tests.json');
  return fs.existsSync(p)
    ? readStoredJSON(
        p,
        (value): value is ConnectionTest[] => StoredConnectionTests.safeParse(value).success,
      )
    : [];
}
export function publicConnections(includeTests = true) {
  let tests: ConnectionTest[] = [];
  let testLogWarning: string | undefined;
  if (includeTests) {
    try {
      tests = connectionTests();
    } catch {
      testLogWarning = '连接测试日志不可读；原文件保留，请按数据恢复说明检查。连接配置仍可使用。';
    }
  }
  return connections().map(({ apiKey, ...c }) => ({
    ...c,
    ...(testLogWarning ? { testLogWarning } : {}),
    configured: !!apiKey && !!c.model,
    hasKey: !!apiKey,
    inUse: connectionInUse(c.connectionId),
    lastTest:
      tests
        .slice()
        .reverse()
        .find(
          (t) =>
            Object.hasOwn(t, 'configUpdatedAt') &&
            (t.connectionId === c.connectionId || (!t.connectionId && t.slot === c.slot)) &&
            t.model === c.model &&
            t.baseURL === c.baseURL &&
            t.protocol === c.protocol &&
            t.configUpdatedAt === c.updatedAt,
        ) || null,
  }));
}
