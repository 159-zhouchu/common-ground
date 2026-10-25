import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Connection, RunOptions } from '../lib/types';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-connections-'));
process.env.CG_DATA_DIR = dir;
const store = await import('../lib/store');
const settings = await import('../lib/connection-settings');
const { startRun, stopRun } = await import('../lib/runner');
const { seed } = await import('../lib/seed');
const { MAX_CONNECTIONS, MAX_CONCURRENT_REQUESTS } = await import('../lib/limits');
const calls: { model: string; url: string; auth: string; input: Record<string, unknown> }[] = [];
let delay = 0,
  active = 0,
  peak = 0;
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  calls.push({
    model: body.model,
    url: req.url!,
    auth: req.headers.authorization!,
    input: JSON.parse(body.input?.[0]?.content || body.messages.at(-1).content).input,
  });
  active++;
  peak = Math.max(peak, active);
  await new Promise((r) => setTimeout(r, delay));
  active--;
  res.setHeader('Content-Type', 'application/json');
  if (body.model === 'fail') {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: req.headers.authorization }));
    return;
  }
  const review = {
    summary: body.model === 'echo' ? req.headers.authorization : '本机模拟结果',
    findings: [],
    questions: [],
  };
  res.setHeader('x-request-id', body.model === 'echo' ? req.headers.authorization! : 'mock');
  res.end(
    JSON.stringify({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(review) }] }],
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(review) } }],
      usage: { input_tokens: 30, output_tokens: 10, extra: req.headers.authorization },
    }),
  );
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(mock.address() as { port: number }).port}/v1`;
const key = 'FAKE_SECRET_MUST_NOT_BE_RETURNED';
const connection = (i: number): Connection => ({
  connectionId: 'id-' + i,
  label: '用途 ' + i,
  enabled: true,
  baseURL: url,
  apiKey: key,
  model: 'model-' + i,
  protocol: 'responses',
  structured: true,
  inputPrice: 1,
  outputPrice: 2,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
const task = () => {
  const t = seed().tasks[0];
  t.id = randomUUID();
  t.example = false;
  store.transact((s) => s.tasks.push(t));
  return t;
};
const opts = (strategy: 'S0' | 'S1' | 'S5' = 'S0', a = 'id-2', b = 'id-7'): RunOptions => ({
  strategy,
  slot: 'a',
  roleAssignments: { a, b },
  compareRole: 'b',
  selfCheck: false,
  mode: 'live',
  contextMode: 'continue',
  budget: null,
});
async function done(t: string, id: string) {
  for (let i = 0; i < 300; i++) {
    const r = store.getTask(t).runs.find((r) => r.id === id)!;
    if (r.state !== 'running') {
      await new Promise((r) => setTimeout(r, 5));
      return r;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout');
}
async function until(fn: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition timeout');
}

test('dynamic connections: isolated migration, routing, snapshots and privacy', async (t) => {
  t.after(() => {
    mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await t.test(
    'legacy A/B migrate byte-preserving backup, stable IDs, idempotently; legacy history unchanged',
    () => {
      const old = ['a', 'b'].map((slot, i) => {
        const { connectionId, enabled, createdAt, updatedAt, ...rest } = connection(i);
        return { ...rest, slot };
      });
      const bytes = JSON.stringify(old, null, 1);
      fs.writeFileSync(path.join(dir, 'connections.json'), bytes);
      const before = store.readStore();
      const first = store.connections();
      assert.deepEqual(
        first.map((c) => c.connectionId),
        ['legacy-a', 'legacy-b'],
      );
      assert.equal(first[0].apiKey, key);
      assert.equal(first[0].createdAt, null);
      assert.equal(first[0].updatedAt, null);
      assert.equal(fs.readFileSync(path.join(dir, 'backups/connections-v1.json'), 'utf8'), bytes);
      assert.deepEqual(store.connections(), first);
      assert.deepEqual(store.readStore(), before);
    },
  );
  await t.test(
    '10 stored/read; 11th and duplicate ID refused; repeated models allowed; copy excludes key and makes unique ID',
    () => {
      store.saveConnections([connection(0)]);
      settings.copyConnection('id-0');
      const copy = store.connections()[1];
      assert.notEqual(copy.connectionId, 'id-0');
      assert.equal(copy.apiKey, '');
      assert.equal(copy.model, 'model-0');
      assert.equal(calls.length, 0);
      store.saveConnections(Array.from({ length: MAX_CONNECTIONS }, (_, i) => connection(i)));
      assert.equal(store.publicConnections().length, 10);
      assert.throws(() => settings.saveOneConnection(connection(10)), /最多保存/);
      assert.throws(() => settings.copyConnection('id-0'), /最多保存/);
      assert.throws(() => store.saveConnections([connection(0), connection(0)]), /不能重复/);
      assert.equal(store.connections().length, 10);
    },
  );
  await t.test(
    'S0, self-check, S1 selected comparator, S5 and legacy B route only their assigned connections',
    async () => {
      for (const [strategy, selfCheck, expected] of [
        ['S0', false, ['model-2']],
        ['S0', true, ['model-2', 'model-2']],
        ['S1', false, ['model-2', 'model-7', 'model-7']],
        ['S5', false, ['model-2', 'model-7']],
      ] as const) {
        calls.length = 0;
        const t = task(),
          id = randomUUID();
        startRun(t.id, { ...opts(strategy), selfCheck }, id);
        const r = await done(t.id, id);
        assert.equal(r.state, 'succeeded');
        assert.deepEqual(
          calls
            .map((c) => c.model)
            .slice(0, 2)
            .sort(),
          expected.slice(0, 2).sort(),
        );
        assert.deepEqual(calls.map((c) => c.model).slice(2), expected.slice(2));
        assert.ok(r.steps.every((s) => s.connectionId && s.connectionSnapshot?.model));
        assert.ok(!JSON.stringify(r).includes(key));
      }
      store.saveConnections(
        store.connections().map((c) => (c.connectionId === 'id-7' ? { ...c, slot: 'b' } : c)),
      );
      calls.length = 0;
      const t = task(),
        id = randomUUID();
      startRun(t.id, { ...opts(), roleAssignments: undefined, slot: 'b' }, id);
      await done(t.id, id);
      assert.deepEqual(
        calls.map((c) => c.model),
        ['model-7'],
      );
    },
  );
  await t.test(
    'partial failure preserves completed candidate and does not retry failed supplier',
    async () => {
      settings.saveOneConnection({ ...connection(4), model: 'fail' });
      calls.length = 0;
      const t = task(),
        id = randomUUID();
      startRun(t.id, opts('S1', 'id-4', 'id-7'), id);
      const r = await done(t.id, id);
      assert.equal(r.state, 'partial');
      assert.equal(r.steps[0].status, 'failed');
      assert.deepEqual(
        calls.map((c) => c.model),
        ['fail', 'model-7', 'model-7'],
      );
      assert.ok(!JSON.stringify(r).includes(key));
      settings.saveOneConnection(connection(4));
    },
  );
  await t.test('disabled/deleted selection rejects without fallback or calls', () => {
    settings.saveOneConnection({ ...connection(3), enabled: false });
    const t = task(),
      before = calls.length;
    assert.throws(() => startRun(t.id, opts('S0', 'id-3'), randomUUID()), /未选择可用连接/);
    settings.deleteConnection('id-3');
    assert.throws(() => startRun(t.id, opts('S0', 'id-3'), randomUUID()), /未选择可用连接/);
    assert.equal(calls.length, before);
    settings.saveOneConnection(connection(3));
  });
  await t.test(
    'running edit leaves all subsequent steps on original model/address/key/protocol; busy delete blocked; history independent after rename/delete',
    async () => {
      delay = 90;
      calls.length = 0;
      const t = task(),
        id = randomUUID();
      startRun(t.id, { ...opts('S0'), selfCheck: true }, id);
      await until(() => calls.length === 1);
      assert.equal(store.publicConnections().find((c) => c.connectionId === 'id-2')?.inUse, true);
      assert.throws(() => settings.deleteConnection('id-2'), /正在运行/);
      settings.saveOneConnection({
        ...connection(2),
        label: '改名',
        model: 'new-model',
        baseURL: url + '/new',
        apiKey: 'NEW_FAKE_KEY',
        protocol: 'chat',
      });
      const r = await done(t.id, id);
      assert.equal(r.state, 'succeeded');
      assert.deepEqual(
        calls.map((c) => [c.model, c.url, c.auth]),
        [
          ['model-2', '/v1/responses', 'Bearer ' + key],
          ['model-2', '/v1/responses', 'Bearer ' + key],
        ],
      );
      assert.equal(r.connectionSnapshots?.[0].label, '用途 2');
      assert.equal(r.connectionSnapshots?.[0].model, 'model-2');
      settings.deleteConnection('id-2');
      assert.deepEqual(store.getTask(t.id).runs[0], r);
      settings.saveOneConnection(connection(2));
      delay = 0;
    },
  );
  await t.test(
    'saved test state is exact; unsaved protocol/key test never certifies saved config; logs and responses exclude secrets',
    async () => {
      const c = store.connections().find((c) => c.connectionId === 'id-2')!;
      const record = await settings.testConnection(c);
      assert.equal(record.success, true);
      assert.equal(
        store.publicConnections().find((item) => item.connectionId === c.connectionId)?.lastTest
          ?.id,
        record.id,
      );
      await settings.testConnection({ ...c, apiKey: 'OTHER_FAKE_KEY', protocol: 'chat' });
      assert.equal(
        store.publicConnections().find((item) => item.connectionId === c.connectionId)?.lastTest
          ?.id,
        record.id,
      );
      settings.saveOneConnection({ ...c, model: 'echo' });
      const t = task(),
        id = randomUUID();
      startRun(t.id, opts(), id);
      await done(t.id, id);
      assert.ok(!JSON.stringify(store.getTask(t.id)).includes(key));
      await assert.rejects(settings.testConnection({ ...c, model: 'fail' }), /HTTP 401/);
      assert.ok(!fs.readFileSync(path.join(dir, 'connection-tests.json'), 'utf8').includes(key));
      assert.ok(!JSON.stringify(store.publicConnections()).includes(key));
      settings.saveOneConnection(c);
    },
  );
  await t.test(
    'corrupt probe log preserves successful paid-call outcome and original log',
    async () => {
      const file = path.join(dir, 'connection-tests.json');
      const old = fs.readFileSync(file, 'utf8');
      try {
        fs.writeFileSync(file, '{broken-log');
        const c = store.connections().find((c) => c.connectionId === 'id-2')!;
        const result = await settings.testConnection(c);
        assert.equal(result.success, true);
        assert.ok(result.warning);
        assert.notEqual(result.input, null);
        assert.ok(store.publicConnections()[0].testLogWarning);
        assert.equal(fs.readFileSync(file, 'utf8'), '{broken-log');
      } finally {
        fs.writeFileSync(file, old);
      }
    },
  );
  await t.test(
    'global request concurrency stays <=2 across runs/probes; queued cancellation is unsent; no retry or fallback',
    async () => {
      delay = 150;
      calls.length = 0;
      peak = 0;
      const tasks = [task(), task(), task()],
        ids = tasks.map(() => randomUUID());
      tasks.forEach((t, i) => startRun(t.id, opts('S0', 'id-' + i), ids[i]));
      await until(() => calls.length === 2);
      stopRun(tasks[2].id, ids[2]);
      const probe = settings.testConnection(store.connections()[4]);
      await Promise.all([done(tasks[0].id, ids[0]), done(tasks[1].id, ids[1]), probe]);
      assert.equal(store.getTask(tasks[2].id).runs[0].steps[0].sent, false);
      assert.equal(calls.length, 3);
      assert.ok(peak <= MAX_CONCURRENT_REQUESTS);
      delay = 0;
    },
  );
});
