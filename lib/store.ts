import fs from 'node:fs';
import path from 'node:path';
import type { Store, Task, Connection, LegacyConnection, ConnectionTest } from './types';
import { MAX_CONNECTIONS } from './limits';
import { connectionInUse, taskInFlight } from './execution';
import { seed, now } from './seed';
import { AppError, requireIdle, current } from './domain';
import { writeAtomic } from './atomic-file';
import { jsonStore } from './json-store';
export { writeAtomic } from './atomic-file';
// Local mutable state must never be bundled into a traced deployment artifact.
const root = path.resolve(/*turbopackIgnore: true*/ process.env.CG_DATA_DIR || '.data');
const file = path.join(root, 'workspace.json');
const workspace = jsonStore<Store>(file, seed, (s) => {
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
});
function ensure() {
  workspace.read(() => null);
}
export function readStore(): Store {
  return workspace.read();
}
export function transact<T>(fn: (s: Store) => T): T {
  return workspace.transact(fn);
}
export function getTask(id: string) {
  const t = workspace.read((s) => s.tasks.find((t) => t.id === id));
  if (!t) throw new AppError('NOT_FOUND', '项目不存在', 404);
  return t;
}
export function editTask<T>(id: string, fn: (t: Task) => T) {
  return transact((s) => {
    const t = s.tasks.find((t) => t.id === id);
    if (!t) throw new AppError('NOT_FOUND', '项目不存在', 404);
    const r = fn(t);
    t.updatedAt = now();
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
    if (s.tasks.length >= 50)
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
  ensure();
  const p = path.join(root, 'connections.json');
  if (!fs.existsSync(p)) return [defaultConnection('a'), defaultConnection('b')];
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (raw.version === 2 && Array.isArray(raw.connections)) return raw.connections;
  if (
    !Array.isArray(raw) ||
    raw.some((c) => !['a', 'b'].includes(c.slot)) ||
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
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  if (!fs.existsSync(backup)) fs.copyFileSync(p, backup, fs.constants.COPYFILE_EXCL);
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
export function publicConnections() {
  const p = path.join(root, 'connection-tests.json');
  const tests: ConnectionTest[] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  return connections().map(({ apiKey, ...c }) => ({
    ...c,
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
