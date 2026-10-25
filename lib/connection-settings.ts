import { z } from 'zod';
import { AppError } from './domain';
import { validateConnection, modelRequest, invoke } from './models';
import {
  connections,
  writeAtomic,
  saveConnections,
  publicConnections,
  connectionTests,
} from './store';
import { lockConnections } from './execution';
import { MAX_CONNECTIONS } from './limits';
import type { Connection, Manifest, ConnectionTest } from './types';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const ConnectionInput = z.object({
  connectionId: z.string().min(1).max(100).optional(),
  slot: z.enum(['a', 'b']).optional(),
  enabled: z.boolean().default(true),
  label: z.string().trim().min(1).max(60),
  baseURL: z.url().max(500),
  apiKey: z.string().trim().max(1000).optional(),
  clearKey: z.boolean().optional(),
  model: z.string().trim().max(120),
  protocol: z.enum(['chat', 'responses']),
  structured: z.boolean(),
  inputPrice: z.number().nonnegative().max(100000).nullable(),
  outputPrice: z.number().nonnegative().max(100000).nullable(),
});

export function resolveConnection(
  input: z.infer<typeof ConnectionInput>,
  old?: Connection,
): Connection {
  const baseURL = input.baseURL.replace(/\/+$/, '');
  if (/\/(responses|chat\/completions)$/.test(baseURL))
    throw new AppError(
      'ENDPOINT_IN_BASE',
      '请填写 API 基础地址，不要附加 /responses 或 /chat/completions；系统会自动补全。',
    );
  if (
    old?.apiKey &&
    !input.apiKey &&
    !input.clearKey &&
    old.baseURL.replace(/\/+$/, '') !== baseURL
  )
    throw new AppError(
      'KEY_DESTINATION_CHANGED',
      '更换 API 地址后，请重新填写密钥或勾选清除旧密钥；不会把旧密钥自动发送到新地址。',
    );
  const c: Connection = {
    connectionId: old?.connectionId || input.connectionId || 'legacy-' + input.slot,
    slot: old?.slot ?? input.slot,
    enabled: input.enabled,
    createdAt: old ? old.createdAt : new Date().toISOString(),
    updatedAt: new Date(
      Math.max(Date.now(), Date.parse(old?.updatedAt || '') + 1 || 0),
    ).toISOString(),
    label: input.label,
    baseURL,
    apiKey: input.clearKey ? '' : input.apiKey || old?.apiKey || '',
    model: input.model,
    protocol: input.protocol,
    structured: input.structured,
    inputPrice: input.inputPrice,
    outputPrice: input.outputPrice,
  };
  validateConnection(c);
  return c;
}

const testing = new Set<string>();
// A separate, bounded log: no credentials, request bodies or supplier response text.
const logFile = path.resolve(
  /*turbopackIgnore: true*/ process.env.CG_DATA_DIR || '.data',
  'connection-tests.json',
);
type TestRecord = ConnectionTest;
function recordTest(record: TestRecord) {
  try {
    const old = connectionTests();
    writeAtomic(logFile, [...old, record].slice(-50));
  } catch {
    record.warning = '本次测试已完成，但测试日志未保存；请保留本次用量并检查数据恢复说明。';
    console.warn({ code: 'TEST_LOG_UNAVAILABLE', file: 'connection-tests.json' });
  }
}

export async function testConnection(input: z.infer<typeof ConnectionInput>) {
  const old = connections().find((c) =>
    input.connectionId
      ? c.connectionId === input.connectionId
      : !!input.slot && c.slot === input.slot,
  );
  const c = resolveConnection(input, old);
  // A draft probe must not certify a different saved configuration (including its key).
  const sameSaved =
    !!old &&
    (
      [
        'label',
        'baseURL',
        'apiKey',
        'model',
        'protocol',
        'structured',
        'inputPrice',
        'outputPrice',
        'enabled',
      ] as const
    ).every((k) => old[k] === c[k]);
  const configUpdatedAt = sameSaved ? old.updatedAt : 'unsaved-draft';
  if (!c.enabled) throw new AppError('CONNECTION_DISABLED', '此连接已停用，请先启用再测试。');
  if (!c.model || !c.apiKey)
    throw new AppError('MODEL_UNAVAILABLE', '请先填写实际模型 ID 和 API 密钥，再测试连接。');
  if (testing.has(c.connectionId))
    throw new AppError('TEST_ACTIVE', '这个模型正在测试，请等待结果；不会重复发起调用。', 409);
  const manifest: Manifest = {
    goal: '连接测试。summary 只写 OK，findings 和 questions 均为空数组。',
    constraint: '不处理任何项目资料。只返回最短的合法 JSON。',
    sources: [],
    blocks: [],
    messages: [],
    mode: 'source_only',
    excluded: ['全部项目资料、成果与讨论'],
    hash: 'connection-test',
  };
  const req = modelRequest(c, manifest, 'answer', 256),
    startedAt = new Date().toISOString(),
    started = Date.now();
  testing.add(c.connectionId);
  const release = lockConnections([c.connectionId]);
  try {
    const result = await invoke(c, req, AbortSignal.timeout(30000));
    const record: TestRecord = {
      id: randomUUID(),
      connectionId: c.connectionId,
      slot: c.slot,
      configUpdatedAt,
      model: c.model,
      baseURL: c.baseURL,
      protocol: c.protocol,
      startedAt,
      latencyMs: Date.now() - started,
      success: true,
      input: result.usage.input,
      output: result.usage.output,
      cost: result.cost,
    };
    recordTest(record);
    return record;
  } catch (e) {
    const error =
      e instanceof AppError
        ? e.code === 'INCOMPLETE_OUTPUT'
          ? new AppError(
              'INCOMPLETE_OUTPUT',
              '接口已回应，但本次测试输出未完整结束。256 tokens 上限也包含推理消耗，可回工作台用正式任务验证；这不一定表示地址或密钥错误。',
              502,
            )
          : e
        : new AppError(
            'CONNECTION_FAILED',
            e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
              ? '连接测试等待超过 30 秒，已停止等待；已发送请求仍可能计费。'
              : '无法连接模型服务，请检查地址、网络和协议；供应商响应内容不会显示在页面中。',
            502,
          );
    recordTest({
      id: randomUUID(),
      connectionId: c.connectionId,
      slot: c.slot,
      configUpdatedAt,
      model: c.model,
      baseURL: c.baseURL,
      protocol: c.protocol,
      startedAt,
      latencyMs: Date.now() - started,
      success: false,
      code: error.code,
      input: null,
      output: null,
      cost: null,
    });
    throw error;
  } finally {
    testing.delete(c.connectionId);
    release();
  }
}

export function saveSettings(raw: unknown) {
  const input = z.array(ConnectionInput).max(MAX_CONNECTIONS).parse(raw);
  const old = connections();
  if (input.some((c) => !c.connectionId && !c.slot))
    throw new AppError('CONNECTION_ID', '请提供稳定连接 ID。');
  const next = input.map((c) => {
    const previous = old.find((o) =>
      c.connectionId ? o.connectionId === c.connectionId : o.slot === c.slot,
    );
    return resolveConnection(c, previous);
  });
  saveConnections(next);
  return publicConnections();
}
export function saveOneConnection(raw: unknown) {
  const input = ConnectionInput.parse(raw);
  if (!input.connectionId) throw new AppError('CONNECTION_ID', '请提供稳定连接 ID。');
  const old = connections(),
    previous = old.find((c) => c.connectionId === input.connectionId);
  const next = resolveConnection(input, previous);
  saveConnections(
    previous ? old.map((c) => (c.connectionId === next.connectionId ? next : c)) : [...old, next],
  );
  return publicConnections();
}
export function deleteConnection(id: string) {
  const old = connections();
  if (!old.some((c) => c.connectionId === id)) throw new AppError('NOT_FOUND', '连接不存在', 404);
  saveConnections(old.filter((c) => c.connectionId !== id));
  return publicConnections();
}
export function copyConnection(id: string) {
  const old = connections();
  if (old.length >= MAX_CONNECTIONS)
    throw new AppError('CONNECTION_LIMIT', `最多保存 ${MAX_CONNECTIONS} 个连接。`);
  const c = old.find((c) => c.connectionId === id);
  if (!c) throw new AppError('NOT_FOUND', '连接不存在', 404);
  const stamp = new Date().toISOString();
  saveConnections([
    ...old,
    {
      ...c,
      slot: undefined,
      connectionId: randomUUID(),
      label: c.label.slice(0, 55) + ' 副本',
      apiKey: '',
      createdAt: stamp,
      updatedAt: stamp,
    },
  ]);
  return publicConnections();
}
