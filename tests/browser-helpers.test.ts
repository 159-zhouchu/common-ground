import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { retryKey, writeLocal } from '../lib/browser-storage';
import { api, responseJSON, localFetch } from '../lib/client-api';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key(index: number) {
      return [...data.keys()][index] ?? null;
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
}
test('browser persistence protects authored data, retries quota once and refuses unrecorded paid submissions', () => {
  const local = memoryStorage(),
    session = memoryStorage();
  const oldLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session });
  try {
    local.setItem('cg-draft-other', 'draft');
    local.setItem('cg-review-other', 'criteria');
    local.setItem('cg-connections-other', 'rebuildable');
    let attempts = 0;
    const set = local.setItem.bind(local);
    const quota = mock.method(local, 'setItem', (key: string, value: string) => {
      attempts++;
      if (attempts === 1) throw new Error('quota');
      set(key, value);
    });
    assert.equal(writeLocal('cg-draft-current', 'important'), true);
    assert.equal(attempts, 2);
    assert.equal(local.getItem('cg-connections-other'), null);
    assert.equal(local.getItem('cg-draft-other'), 'draft');
    assert.equal(local.getItem('cg-review-other'), 'criteria');
    quota.mock.restore();
    const fail = mock.method(local, 'setItem', () => {
      throw new Error('disabled');
    });
    assert.equal(writeLocal('cg-draft-current', 'changed'), false);
    assert.equal(local.getItem('cg-draft-current'), 'important');
    fail.mock.restore();
    const first = retryKey('run', 'same-request');
    assert.equal(retryKey('run', 'same-request'), first);
    assert.notEqual(retryKey('run', 'different-request'), first);
    mock.method(session, 'setItem', () => {
      throw new Error('disabled');
    });
    assert.throws(() => retryKey('new-run', 'request'), /尚未提交/);
  } finally {
    mock.restoreAll();
    if (oldLocal) Object.defineProperty(globalThis, 'localStorage', oldLocal);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    if (oldSession) Object.defineProperty(globalThis, 'sessionStorage', oldSession);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});
test('client API reports null, non-JSON, HTTP and network failures safely; explicit abort remains distinguishable', async () => {
  await assert.rejects(responseJSON(Response.json(null)), /请求失败/);
  await assert.rejects(
    responseJSON(new Response('<html>error</html>', { status: 500 })),
    /无法读取/,
  );
  await assert.rejects(
    responseJSON(Response.json({ error: '明确错误', code: 'TEST' }, { status: 409 })),
    /明确错误/,
  );
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('Failed to fetch');
  });
  try {
    await assert.rejects(api('test'), /无法连接本机服务或请求超时/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(localFetch('/api/test', { signal: controller.signal }), /Failed to fetch/);
  } finally {
    fetchMock.mock.restore();
  }
});
