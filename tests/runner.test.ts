import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
process.env.CG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-runner-'));
const {
  readStore,
  transact,
  getTask,
  saveConnections,
  publicConnections,
  renameTask,
  archiveTask,
  restoreTask,
} = await import('../lib/store');
const { startRun, stopRun } = await import('../lib/runner');
const { current, manifest, plan } = await import('../lib/domain');
const { connections } = await import('../lib/store');
const { modelRequest, reserveCost } = await import('../lib/models');
const { seed } = await import('../lib/seed');
const requests: Record<string, unknown>[] = [];
let delay = 0,
  reportUsage = true,
  fail = false,
  outputSize = 0;
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const m = JSON.parse(body.input[0].content).input;
  requests.push(m);
  if (fail) {
    res.writeHead(500);
    res.end('{}');
    return;
  }
  const review = {
    summary: '本地协议模拟结果（不代表模型效果）' + 'x'.repeat(outputSize),
    findings: [],
    questions: [],
  };
  await new Promise((r) => setTimeout(r, delay));
  res.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': 'mock-local-request' });
  res.end(
    JSON.stringify({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(review) }] }],
      usage: reportUsage ? { input_tokens: 123, output_tokens: 45 } : {},
    }),
  );
});
await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
const addr = mock.address() as { port: number };
function fresh() {
  const t = seed().tasks[0];
  t.id = randomUUID();
  t.example = false;
  transact((s) => s.tasks.push(t));
  return t;
}
function configure() {
  saveConnections(
    ['a', 'b'].map((slot) => ({
      slot: slot as 'a' | 'b',
      label: slot,
      baseURL: `http://127.0.0.1:${addr.port}/v1`,
      apiKey: 'LOCAL_MOCK_KEY',
      model: 'local-mock',
      protocol: 'responses',
      structured: true,
      inputPrice: 1,
      outputPrice: 2,
    })),
  );
}
async function finished(id: string, runId: string) {
  for (let i = 0; i < 150; i++) {
    const r = getTask(id).runs.find((r) => r.id === runId)!;
    if (r.state !== 'running') return r;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Run test timeout');
}
test('runner integration', async (t) => {
  t.after(() => {
    mock.close();
    fs.rmSync(process.env.CG_DATA_DIR!, { recursive: true, force: true });
  });
  readStore();
  configure();
  await t.test('S1 实际请求隔离，比较阶段显式读取两候选；同幂等键不重复调用', async () => {
    requests.length = 0;
    const task = fresh(),
      id = randomUUID();
    const opts = {
      strategy: 'S1' as const,
      contextMode: 'source_only' as const,
      selfCheck: false,
      mode: 'live' as const,
      slot: 'a' as const,
      budget: null,
    };
    startRun(task.id, opts, id);
    startRun(task.id, opts, id);
    const r = await finished(task.id, id);
    assert.equal(r.state, 'succeeded');
    assert.equal(requests.length, 3);
    assert.equal((requests[0].blocks as unknown[]).length, 0);
    assert.equal((requests[1].messages as unknown[]).length, 0);
    assert.ok(!requests[0].priorOutputs);
    assert.ok(!requests[1].priorOutputs);
    assert.equal((requests[2].priorOutputs as unknown[]).length, 2);
    assert.ok((requests[2].blocks as unknown[]).length > 0);
    assert.ok(r.steps.every((s) => s.inputHash && s.usage?.input === 123));
    assert.equal(r.steps[0].cost, 0.000213);
  });
  await t.test('停止后迟到调用不进入成果或讨论，调用记录仍然保留', async () => {
    delay = 120;
    const task = fresh(),
      id = randomUUID();
    startRun(
      task.id,
      {
        strategy: 'S0',
        contextMode: 'continue',
        selfCheck: false,
        mode: 'live',
        slot: 'a',
        budget: null,
      },
      id,
    );
    stopRun(task.id, id);
    await new Promise((r) => setTimeout(r, 180));
    const latest = getTask(task.id);
    assert.equal(latest.runs[0].state, 'cancelled');
    assert.equal(latest.messages.length, 0);
    assert.equal(latest.findings.length, 0);
    assert.equal(latest.currentRevision, task.currentRevision);
    delay = 0;
  });
  await t.test('不同项目复用幂等键时，停止只取消指定项目', async () => {
    delay = 120;
    try {
      const a = fresh(),
        b = fresh(),
        id = randomUUID(),
        opts = {
          strategy: 'S0' as const,
          contextMode: 'continue' as const,
          selfCheck: false,
          mode: 'live' as const,
          slot: 'a' as const,
          budget: null,
        };
      startRun(a.id, opts, id);
      startRun(b.id, opts, id);
      stopRun(a.id, id);
      assert.equal((await finished(b.id, id)).state, 'succeeded');
      assert.equal(getTask(a.id).runs[0].state, 'cancelled');
      assert.equal(getTask(b.id).messages.length, 1);
    } finally {
      delay = 0;
    }
  });
  await t.test('金额上限在调度前检查，超预算不发送请求', async () => {
    requests.length = 0;
    const task = fresh(),
      id = randomUUID();
    startRun(
      task.id,
      {
        strategy: 'S0',
        contextMode: 'continue',
        selfCheck: false,
        mode: 'live',
        slot: 'a',
        budget: 0.000001,
      },
      id,
    );
    const r = await finished(task.id, id);
    assert.equal(r.state, 'failed');
    assert.equal(requests.length, 0);
    assert.match(r.steps[0].error!, /预算/);
  });
  await t.test('S0自检、S5与S1均按已结算费用释放预留，缺用量不释放', async () => {
    for (const strategy of ['S0', 'S5', 'S1'] as const) {
      requests.length = 0;
      const task = fresh(),
        c = connections()[0],
        id = randomUUID();
      const opts = {
        strategy,
        contextMode: 'continue' as const,
        selfCheck: true,
        mode: 'live' as const,
        slot: 'a' as const,
        budget: null as number | null,
      };
      const steps = plan(opts),
        review = { summary: '本地协议模拟结果（不代表模型效果）', findings: [], questions: [] };
      const estimates = steps.map((step, i) => {
        const m = manifest(task, 'continue');
        if (i && strategy !== 'S1') m.priorOutputs = [review];
        if (strategy === 'S1' && i === 2) m.priorOutputs = [review, review];
        const req = modelRequest(c, m, step.duty);
        return reserveCost(c, req.upperInput, req.maxOutput)!;
      });
      opts.budget =
        Math.max(
          strategy === 'S1' ? estimates[0] + estimates[1] : estimates[0],
          (strategy === 'S1' ? 2 : 1) * 0.000213 + estimates.at(-1)!,
        ) + 0.000001;
      assert.ok(opts.budget < estimates.reduce((a, b) => a + b));
      startRun(task.id, opts, id);
      const result = await finished(task.id, id);
      assert.equal(result.state, 'succeeded', JSON.stringify(result.steps));
      assert.equal(requests.length, steps.length);
    }
    reportUsage = false;
    try {
      requests.length = 0;
      const task = fresh(),
        id = randomUUID(),
        c = connections()[0];
      const req = modelRequest(c, manifest(task, 'continue'), 'answer');
      startRun(
        task.id,
        {
          strategy: 'S0',
          contextMode: 'continue',
          selfCheck: true,
          mode: 'live',
          slot: 'a',
          budget: reserveCost(c, req.upperInput, req.maxOutput)! + 0.001,
        },
        id,
      );
      const result = await finished(task.id, id);
      assert.equal(result.state, 'partial');
      assert.equal(requests.length, 1);
      assert.equal(result.steps[0].cost, null);
      assert.match(result.steps[1].error!, /预算/);
    } finally {
      reportUsage = true;
    }
  });
  await t.test('过大输入不发送请求、不持久化大清单且保留原稿', async () => {
    requests.length = 0;
    const task = fresh(),
      id = randomUUID();
    transact((s) => {
      s.tasks.find((t) => t.id === task.id)!.revisions[0].blocks[0].content = '中'.repeat(40000);
    });
    assert.throws(
      () =>
        startRun(
          task.id,
          {
            strategy: 'S0',
            contextMode: 'continue',
            selfCheck: false,
            mode: 'live',
            slot: 'a',
            budget: null,
          },
          id,
        ),
      /100 KB/,
    );
    assert.equal(requests.length, 0);
    assert.equal(getTask(task.id).runs.length, 0);
    assert.equal(current(getTask(task.id)).blocks[0].content.length, 40000);
  });
  await t.test('多步近 80 KB 输入与 9 KB 前序结果可完成，超限在启动前拒绝', async () => {
    for (const strategy of ['S0', 'S1', 'S5'] as const) {
      const task = fresh();
      transact((s) => {
        const t = s.tasks.find((t) => t.id === task.id)!;
        t.revisions[0].blocks[0].content = 'x'.repeat(50000);
        t.sources[0].text = 'x'.repeat(22000);
      });
      const id = randomUUID();
      outputSize = 8500;
      requests.length = 0;
      try {
        startRun(
          task.id,
          {
            strategy,
            contextMode: 'continue',
            selfCheck: true,
            mode: 'live',
            slot: 'a',
            budget: null,
          },
          id,
        );
        const r = await finished(task.id, id);
        assert.equal(r.state, 'succeeded', JSON.stringify(r.steps));
        assert.ok(requests.every((m) => Buffer.byteLength(JSON.stringify(m)) < 100000));
      } finally {
        outputSize = 0;
      }
    }
    const task = fresh();
    transact((s) => {
      s.tasks.find((t) => t.id === task.id)!.revisions[0].blocks[0].content = '中'.repeat(30000);
    });
    const n = requests.length;
    assert.throws(
      () =>
        startRun(
          task.id,
          {
            strategy: 'S1',
            contextMode: 'source_only',
            selfCheck: false,
            mode: 'live',
            slot: 'a',
            budget: null,
          },
          randomUUID(),
        ),
      /80 KB/,
    );
    assert.equal(requests.length, n);
    assert.equal(getTask(task.id).runs.length, 0);
  });
  await t.test('多步讨论每步只带一条当前提问，成功后仅持久化一对问答', async () => {
    for (const strategy of ['S0', 'S1', 'S5'] as const) {
      requests.length = 0;
      const task = fresh(),
        id = randomUUID(),
        question = `多步提问 ${strategy}`;
      startRun(
        task.id,
        {
          strategy,
          contextMode: 'continue',
          selfCheck: true,
          mode: 'live',
          slot: 'a',
          budget: null,
        },
        id,
        question,
      );
      const result = await finished(task.id, id);
      assert.equal(result.state, 'succeeded');
      assert.ok(requests.length > 1);
      for (const input of requests) {
        const messages = input.messages as { actor: string; content: string }[];
        assert.equal(
          messages.filter((m) => m.actor === 'user' && m.content === question).length,
          1,
        );
      }
      const stored = getTask(task.id).messages;
      assert.deepEqual(
        stored.map((m) => m.actor),
        ['user', 'assistant'],
      );
      assert.equal(stored[0].content, question);
    }
  });
  await t.test('讨论成功成对保存且幂等；失败、取消与校验失败不产生孤立提问', async () => {
    const opts = {
      strategy: 'S0' as const,
      contextMode: 'continue' as const,
      selfCheck: false,
      mode: 'live' as const,
      slot: 'a' as const,
      budget: null,
    };
    const task = fresh(),
      id = randomUUID();
    startRun(task.id, opts, id, '问题一');
    startRun(task.id, opts, id, '问题一');
    await finished(task.id, id);
    assert.deepEqual(
      getTask(task.id).messages.map((m) => m.actor),
      ['user', 'assistant'],
    );
    assert.equal(getTask(task.id).messages[0].content, '问题一');
    fail = true;
    try {
      const id2 = randomUUID();
      startRun(task.id, opts, id2, '失败提问');
      await finished(task.id, id2);
    } finally {
      fail = false;
    }
    assert.equal(getTask(task.id).messages.length, 2);
    delay = 120;
    try {
      const id3 = randomUUID();
      startRun(task.id, opts, id3, '取消提问');
      stopRun(task.id, id3);
      assert.throws(() => archiveTask(task.id, task.currentRevision), /等待/);
      await new Promise((r) => setTimeout(r, 160));
    } finally {
      delay = 0;
    }
    assert.equal(getTask(task.id).messages.length, 2);
    assert.throws(() =>
      startRun(task.id, { ...opts, roleAssignments: { a: 'missing' } }, randomUUID(), '无效连接'),
    );
    assert.equal(getTask(task.id).messages.length, 2);
  });
  await t.test('项目改名与回收恢复保留完整记录，运行中不可移走', async () => {
    const task = fresh(),
      before = JSON.stringify(task.revisions);
    renameTask(task.id, '新名称', task.currentRevision);
    assert.equal(getTask(task.id).title, '新名称');
    assert.equal(JSON.stringify(getTask(task.id).revisions), before);
    assert.throws(() => archiveTask(task.id, 'old'), /更新/);
    delay = 100;
    const id = randomUUID();
    startRun(
      task.id,
      {
        strategy: 'S0',
        contextMode: 'continue',
        selfCheck: false,
        mode: 'live',
        slot: 'a',
        budget: null,
      },
      id,
    );
    assert.throws(() => archiveTask(task.id, task.currentRevision), /运行/);
    await finished(task.id, id);
    delay = 0;
    const snapshot = getTask(task.id);
    archiveTask(task.id, task.currentRevision);
    assert.throws(() => getTask(task.id));
    assert.deepEqual(
      readStore().archivedTasks!.find((t) => t.id === task.id),
      snapshot,
    );
    restoreTask(task.id);
    assert.deepEqual(getTask(task.id), snapshot);
  });
  await t.test('读取密钥配置只返回 hasKey，不返回密钥', () => {
    assert.ok(!JSON.stringify(publicConnections()).includes('LOCAL_MOCK_KEY'));
    assert.ok(publicConnections().every((c) => c.hasKey));
  });
  await t.test('暂缓后重复检查不制造重复待办，材料新版仍可重新核查', async () => {
    const task = seed().tasks[0];
    task.id = randomUUID();
    transact((s) => s.tasks.push(task));
    const opts = {
      strategy: 'S0' as const,
      mode: 'demo' as const,
      contextMode: 'continue' as const,
      selfCheck: false,
      slot: 'a' as const,
      budget: null,
    };
    let id = randomUUID();
    startRun(task.id, opts, id);
    await finished(task.id, id);
    const first = getTask(task.id);
    assert.equal(first.findings.length, 3);
    transact((s) => {
      s.tasks.find((t) => t.id === task.id)!.findings[0].status = 'deferred';
    });
    id = randomUUID();
    startRun(task.id, opts, id);
    await finished(task.id, id);
    assert.equal(getTask(task.id).findings.length, 3);
    assert.equal(getTask(task.id).runs.at(-1)!.findings.length, 0);
    transact((s) => {
      s.tasks.find((t) => t.id === task.id)!.sources.forEach((source) => source.version++);
    });
    id = randomUUID();
    startRun(task.id, opts, id);
    await finished(task.id, id);
    assert.ok(getTask(task.id).findings.length > 3);
  });
  await t.test('项目满 50 个时回收释放名额，恢复超额时不丢数据', () => {
    const before = readStore();
    try {
      transact((s) => {
        while (s.tasks.length < 50) {
          const t = structuredClone(s.tasks[0]);
          t.id = randomUUID();
          s.tasks.push(t);
        }
      });
      const first = readStore().tasks[0];
      archiveTask(first.id, first.currentRevision);
      assert.equal(readStore().tasks.length, 49);
      const extra = fresh();
      assert.equal(readStore().tasks.length, 50);
      assert.throws(() => restoreTask(first.id), /50/);
      assert.ok(readStore().archivedTasks!.some((t) => t.id === first.id));
      archiveTask(extra.id, extra.currentRevision);
      restoreTask(first.id);
      assert.equal(readStore().tasks.length, 50);
    } finally {
      transact((s) => {
        s.tasks = before.tasks;
        s.archivedTasks = before.archivedTasks;
      });
    }
  });
  await t.test('S5 不能同时声称不读现有方案；普通项目不能运行预置示例', () => {
    const task = fresh();
    assert.throws(() =>
      startRun(
        task.id,
        {
          strategy: 'S5',
          contextMode: 'source_only',
          selfCheck: false,
          mode: 'live',
          slot: 'a',
          budget: null,
        },
        randomUUID(),
      ),
    );
    assert.throws(() =>
      startRun(
        task.id,
        {
          strategy: 'S0',
          contextMode: 'continue',
          selfCheck: false,
          mode: 'demo',
          slot: 'a',
          budget: null,
        },
        randomUUID(),
      ),
    );
  });
});
