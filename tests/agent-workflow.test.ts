import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
process.env.CG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-agents-'));
const {
  startAgentJob,
  getAgentJob,
  stopAgentJob,
  listAgentJobs,
  archiveAgentJob,
  restoreAgentJob,
  listArchivedAgentJobs,
} = await import('../lib/agent-workflow');
const { saveConnections } = await import('../lib/store');
const { connectionInUse } = await import('../lib/execution');
const { agentRoles } = await import('../lib/agent-contract');
type Role = (typeof agentRoles)[number];
const requests: { role: Role; previous: unknown[]; context: unknown[]; goal: string }[] = [];
let failRole = '',
  slow = 0,
  active = 0,
  maxActive = 0,
  reportUsage = true,
  needsInput = false,
  outputSize = 0;
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  const input = JSON.parse(body.input?.[0]?.content || body.messages[1].content);
  requests.push(input);
  active++;
  maxActive = Math.max(active, maxActive);
  await new Promise((r) => setTimeout(r, slow));
  active--;
  if (input.role === failRole) {
    res.writeHead(500);
    res.end('{"secret":"MOCK_ONLY_KEY"}');
    return;
  }
  const output = {
    summary: input.role + ' 的建议 MOCK_ONLY_KEY' + 'x'.repeat(outputSize),
    steps: [{ task: '核对实际文件', files: ['example.ts'], checks: ['运行相关测试'] }],
    risks: ['尚未执行'],
    questions: needsInput ? ['需要目标文件'] : [],
    ready: !needsInput,
  };
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
      usage: reportUsage
        ? { input_tokens: 50, output_tokens: 25, prompt_tokens: 50, completion_tokens: 25 }
        : {},
    }),
  );
});
await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
const address = mock.address() as { port: number };
function configure(priced = true) {
  saveConnections(
    agentRoles.map((role, i) => ({
      connectionId: role,
      label: role,
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'MOCK_ONLY_KEY',
      model: role,
      protocol: i % 2 ? ('chat' as const) : ('responses' as const),
      enabled: true,
      createdAt: null,
      updatedAt: null,
      structured: true,
      inputPrice: priced ? 1 : null,
      outputPrice: priced ? 2 : null,
    })),
  );
}
const roles = {
  planner: 'planner',
  analyst: 'analyst',
  reviewer: 'reviewer',
  synthesizer: 'synthesizer',
};
function input(overrides = {}) {
  return {
    idempotencyKey: randomUUID(),
    goal: '为执行 Agent 评审改动',
    phase: 'review',
    context: [{ name: 'example.diff', content: '这是显式提交的上下文' }],
    roles,
    budget: null,
    ...overrides,
  };
}
async function finished(id: string) {
  for (let i = 0; i < 400; i++) {
    const j = getAgentJob(id);
    if (j.state !== 'running') {
      await new Promise((r) => setTimeout(r, 10));
      return j;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('mock timeout');
}

test('Agent 协作调度（仅本机模拟供应商）', async (t) => {
  t.after(() => {
    mock.closeAllConnections();
    mock.close();
    fs.rmSync(process.env.CG_DATA_DIR!, { recursive: true, force: true });
  });
  configure();
  await t.test('四角色按依赖调度，分析和审查隔离；支持两种协议和无密钥结果', async () => {
    requests.length = 0;
    slow = 25;
    const request = input(),
      job = startAgentJob(request);
    assert.ok(connectionInUse('planner'));
    const result = await finished(job.id);
    slow = 0;
    assert.equal(result.state, 'succeeded');
    assert.equal(result.decision, 'ready');
    assert.equal(requests.length, 4);
    assert.equal(requests[0].role, 'planner');
    assert.equal(requests[3].role, 'synthesizer');
    for (const r of requests.filter((r) => r.role === 'analyst' || r.role === 'reviewer')) {
      assert.equal(r.previous.length, 1);
      assert.equal((r.previous[0] as { role: string }).role, 'planner');
    }
    assert.equal(requests[3].previous.length, 3);
    assert.equal(maxActive, 2);
    assert.ok(!connectionInUse('planner'));
    assert.ok(!JSON.stringify(result).includes('MOCK_ONLY_KEY'));
    assert.ok(result.steps.every((s) => s.sent && s.inputHash && s.cost === 0.0001));
    assert.equal(listAgentJobs()[0].id, job.id);
  });
  await t.test('相同幂等键相同输入不重复计费；不同输入返回冲突', async () => {
    const request = input();
    const first = startAgentJob(request);
    startAgentJob(request);
    await finished(first.id);
    const count = requests.length;
    startAgentJob(request);
    assert.equal(requests.length, count);
    assert.throws(
      () => startAgentJob({ ...request, goal: '其他任务' }),
      (e: unknown) => (e as { code: string }).code === 'IDEMPOTENCY_CONFLICT',
    );
  });
  await t.test('某个并行角色失败时保留输出，最终 incomplete，不将部分成功当作可执行', async () => {
    failRole = 'reviewer';
    const job = startAgentJob(input());
    const result = await finished(job.id);
    failRole = '';
    assert.equal(result.state, 'partial');
    assert.equal(result.decision, 'incomplete');
    assert.ok(result.result);
    assert.equal(result.steps[2].state, 'failed');
    assert.ok(!JSON.stringify(result).includes('MOCK_ONLY_KEY'));
  });
  await t.test('规划失败后不调度下游；汇总失败保留各角色记录', async () => {
    for (const role of ['planner', 'synthesizer']) {
      const count = requests.length;
      failRole = role;
      const job = startAgentJob(input()),
        result = await finished(job.id);
      assert.equal(requests.length - count, role === 'planner' ? 1 : 4);
      assert.equal(result.decision, 'incomplete');
      assert.ok(!result.result);
    }
    failRole = '';
  });
  await t.test('预算不足与缺少单价在发请求前拦截', async () => {
    let count = requests.length;
    const job = startAgentJob(input({ budget: 0.000001 })),
      result = await finished(job.id);
    assert.equal(requests.length, count);
    assert.equal(result.state, 'failed');
    assert.equal(result.steps[0].cost, 0);
    configure(false);
    assert.throws(
      () => startAgentJob(input({ budget: 1 })),
      (e: unknown) => (e as { code: string }).code === 'PRICE_REQUIRED',
    );
    configure();
  });
  await t.test('取消停止后续调度，迟到结果不能生成简报', async () => {
    slow = 100;
    const job = startAgentJob(input());
    stopAgentJob(job.id);
    await new Promise((r) => setTimeout(r, 150));
    slow = 0;
    assert.equal(getAgentJob(job.id).state, 'cancelled');
    assert.equal(getAgentJob(job.id).decision, 'incomplete');
    assert.ok(!getAgentJob(job.id).result);
    assert.ok(!connectionInUse('reviewer'));
  });
  await t.test('缺少用量时保留未知费用，必要问题不能成为 ready', async () => {
    reportUsage = false;
    needsInput = true;
    const result = await finished(startAgentJob(input()).id);
    reportUsage = true;
    needsInput = false;
    assert.equal(result.decision, 'needs_input');
    assert.ok(result.steps.every((s) => s.cost === null));
  });
  await t.test('接近 70 KB 初始上下文和三个近 9 KB 输出仍可汇总；超大结果不传给下游', async () => {
    requests.length = 0;
    outputSize = 8500;
    try {
      const result = await finished(
        startAgentJob(
          input({
            context: [
              { name: 'a', content: 'x'.repeat(59000) },
              { name: 'b', content: 'x'.repeat(9500) },
            ],
          }),
        ).id,
      );
      assert.equal(result.state, 'succeeded', JSON.stringify(result.steps));
      assert.equal(requests.length, 4);
      assert.ok(requests.every((r) => Buffer.byteLength(JSON.stringify(r)) <= 100000));
    } finally {
      outputSize = 0;
    }
    requests.length = 0;
    outputSize = 9500;
    try {
      const result = await finished(startAgentJob(input()).id);
      assert.equal(result.state, 'failed');
      assert.equal(requests.length, 1);
      assert.match(result.steps[0].error!, /9 KB/);
    } finally {
      outputSize = 0;
    }
    const count = listAgentJobs().length;
    assert.throws(
      () =>
        startAgentJob(
          input({
            context: [
              { name: 'a', content: 'x'.repeat(60000) },
              { name: 'b', content: 'x'.repeat(10100) },
            ],
          }),
        ),
      /70 KB/,
    );
    assert.equal(listAgentJobs().length, count);
  });
  await t.test('协作回收和恢复保留所有输出且释放活动列表，运行中拒绝回收', async () => {
    slow = 80;
    const running = startAgentJob(input());
    assert.throws(() => archiveAgentJob(running.id), /停止/);
    await finished(running.id);
    slow = 0;
    const snapshot = getAgentJob(running.id);
    archiveAgentJob(running.id);
    assert.ok(!listAgentJobs().some((j) => j.id === running.id));
    assert.ok(listArchivedAgentJobs().some((j) => j.id === running.id));
    assert.equal(getAgentJob(running.id).steps.length, 4);
    assert.deepEqual(restoreAgentJob(running.id), snapshot);
  });
  await t.test('满 100 条记录时回收释放名额，恢复超额不丢历史', async () => {
    const file = path.join(process.env.CG_DATA_DIR!, 'agent-jobs.json'),
      before = fs.readFileSync(file, 'utf8');
    try {
      const jobs = JSON.parse(before);
      while (jobs.length < 100) jobs.push({ ...structuredClone(jobs[0]), id: randomUUID() });
      fs.writeFileSync(file, JSON.stringify(jobs));
      assert.throws(() => startAgentJob(input()), /100/);
      archiveAgentJob(jobs[0].id);
      const next = startAgentJob(input());
      await finished(next.id);
      assert.equal(listAgentJobs().length, 100);
      assert.throws(() => restoreAgentJob(jobs[0].id), /100/);
      assert.ok(listArchivedAgentJobs().some((j) => j.id === jobs[0].id));
      archiveAgentJob(next.id);
      restoreAgentJob(jobs[0].id);
      assert.equal(listAgentJobs().length, 100);
    } finally {
      fs.writeFileSync(file, before);
    }
  });
  await t.test('超大上下文和失效角色在发送前拒绝，不创建调度', () => {
    const count = requests.length;
    assert.throws(
      () => startAgentJob(input({ context: [{ name: 'a', content: '中'.repeat(40000) }] })),
      (e: unknown) => (e as { code: string }).code === 'INPUT_TOO_LARGE',
    );
    assert.throws(
      () => startAgentJob(input({ roles: { ...roles, reviewer: 'missing' } })),
      (e: unknown) => (e as { code: string }).code === 'MODEL_UNAVAILABLE',
    );
    assert.equal(requests.length, count);
  });
});
