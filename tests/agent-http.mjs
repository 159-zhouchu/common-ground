import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { freePort, waitForInstance } from './local-server.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-agent-http-'));
const port = await freePort(),
  instance = randomUUID(),
  base = 'http://127.0.0.1:' + port;
let calls = 0,
  delay = 10;
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw),
    input = JSON.parse(body.input?.[0]?.content || body.messages[1].content);
  calls++;
  await new Promise((r) => setTimeout(r, delay));
  const advice = {
    summary: input.role + ' 为 Agent 提供模拟建议',
    steps: [{ task: '在本地核对测试', files: ['sample.ts'], checks: ['npm test'] }],
    risks: ['模拟输出不代表模型效果'],
    questions: [],
    ready: true,
  };
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(advice) }] }],
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(advice) } }],
      usage: { input_tokens: 10, output_tokens: 10, prompt_tokens: 10, completion_tokens: 10 },
    }),
  );
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const provider = 'http://127.0.0.1:' + mock.address().port;
const env = {
  ...process.env,
  CG_DATA_DIR: dir,
  CG_INSTANCE_ID: instance,
  NEXT_TELEMETRY_DISABLED: '1',
};
let server,
  log = '';
function launch() {
  server = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)],
    { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
}
async function call(route, body, status = 200) {
  const response = await fetch(base + '/api/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
async function finished(id) {
  for (let i = 0; i < 250; i++) {
    const job = await call('agent/jobs/' + id);
    if (job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('isolated timeout');
}
const roles = {
  planner: 'planner',
  analyst: 'analyst',
  reviewer: 'reviewer',
  synthesizer: 'synthesizer',
};
function input() {
  return {
    idempotencyKey: randomUUID(),
    goal: '隔离验收：辅助执行 Agent',
    roles,
    phase: 'plan',
    context: [{ name: 'sample.ts', content: 'export const sample = 1;' }],
    budget: null,
  };
}
async function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/agent-bridge.mjs', ...args], {
      env: { ...process.env, CG_BASE_URL: base },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '',
      error = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (error += d));
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output, error }));
  });
}
const checks = [];
let mcp;
try {
  launch();
  await waitForInstance(base, instance, server, () => log);
  for (const [i, role] of Object.keys(roles).entries())
    await call('connections/save', {
      connection: {
        connectionId: role,
        label: role,
        enabled: true,
        baseURL: provider + '/v1',
        apiKey: 'ISOLATED_ONLY_KEY',
        model: role,
        protocol: i % 2 ? 'chat' : 'responses',
        structured: true,
        inputPrice: 1,
        outputPrice: 2,
      },
    });
  assert.equal((await fetch(base + '/agents')).status, 200);
  checks.push('Agent 页面可访问，配置不发请求');
  assert.equal(calls, 0);
  let job = await call('agent/jobs', input());
  job = await finished(job.id);
  assert.equal(job.state, 'succeeded');
  assert.equal(job.decision, 'ready');
  assert.equal(calls, 4);
  assert.ok(!JSON.stringify(job).includes('ISOLATED_ONLY_KEY'));
  assert.equal(job.steps.length, 4);
  checks.push('真实 HTTP 自动完成四步，输出与身份快照无密钥');
  const hostile = await fetch(base + '/api/agent/jobs', {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(hostile.status, 403);
  await call('agent/jobs', { ...input(), roles: { ...roles, planner: 'missing' } }, 400);
  checks.push('跨来源读取与无效连接在调用前拒绝');
  const requestFile = path.join(dir, 'request.json'),
    outFile = path.join(dir, 'brief.md');
  fs.writeFileSync(path.join(dir, 'sample.ts'), 'export const local = true;');
  const cliInput = input();
  delete cliInput.context;
  cliInput.files = ['sample.ts'];
  fs.writeFileSync(requestFile, JSON.stringify(cliInput));
  const cliResult = await cli(['run', requestFile, '--out', outFile]);
  assert.equal(cliResult.code, 0, cliResult.error);
  assert.ok(fs.readFileSync(outFile, 'utf8').includes('Agent 执行简报'));
  assert.equal(JSON.parse(cliResult.output).context[0].content, 'export const local = true;');
  assert.equal(calls, 8);
  const original = fs.readFileSync(outFile, 'utf8');
  const duplicate = await cli(['run', requestFile, '--out', outFile]);
  assert.equal(duplicate.code, 1);
  assert.equal(calls, 8);
  assert.equal(fs.readFileSync(outFile, 'utf8'), original);
  checks.push('CLI 读取显式 UTF-8 文件、自动等待、输出简报；同键重跑不计费、不覆盖已有输出');
  mcp = new Client({ name: 'isolated-agent-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('scripts/agent-mcp.mjs')],
    env: { ...process.env, CG_BASE_URL: base },
    stderr: 'pipe',
  });
  await mcp.connect(transport);
  const tools = await mcp.listTools();
  assert.equal(tools.tools.length, 5);
  const settings = await mcp.callTool({ name: 'cg_connections', arguments: {} });
  assert.ok(!JSON.stringify(settings).includes('ISOLATED_ONLY_KEY'));
  const start = await mcp.callTool({ name: 'cg_start_job', arguments: input() });
  assert.ok(!start.isError, JSON.stringify(start));
  const started = JSON.parse(start.content[0].text);
  assert.ok(!('context' in started));
  const completed = await mcp.callTool({ name: 'cg_wait_job', arguments: { id: started.id } });
  assert.equal(JSON.parse(completed.content[0].text).decision, 'ready');
  assert.equal(calls, 12);
  checks.push('标准 MCP SDK 客户端完成握手、发现 5 个工具、调度并等待最终简报');
  delay = 300;
  job = await call('agent/jobs', input());
  await call('agent/jobs/' + job.id + '/cancel', {});
  await new Promise((r) => setTimeout(r, 350));
  assert.equal((await call('agent/jobs/' + job.id)).state, 'cancelled');
  checks.push('HTTP 取消停止下游，迟到响应不生成最终结果');
  job = await call('agent/jobs', input());
  server.kill();
  await new Promise((r) => server.once('exit', r));
  launch();
  await waitForInstance(base, instance, server, () => log);
  const interrupted = await call('agent/jobs/' + job.id);
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.decision, 'incomplete');
  checks.push('重启后的在途任务标记 interrupted，不伪装恢复或成功');
  const completedJob = await call('agent/jobs/' + started.id),
    beforeArchiveCalls = calls;
  await call('agent/jobs/' + started.id + '/archive', {});
  assert.ok(!(await call('agent/jobs')).some((j) => j.id === started.id));
  const bin = await call('agent/archived');
  assert.deepEqual(Object.keys(bin.find((j) => j.id === started.id)).sort(), [
    'archivedAt',
    'goal',
    'id',
    'state',
  ]);
  const restored = await call('agent/jobs/' + started.id + '/restore', {});
  assert.deepEqual(restored, completedJob);
  assert.equal(calls, beforeArchiveCalls);
  await call('agent/jobs/' + randomUUID() + '/archive', {}, 404);
  await call('agent/jobs/' + started.id + '/restore', {}, 404);
  checks.push('HTTP 协作记录回收、精简列表、完整恢复及无效 ID，管理操作不调用模型');
  const report = {
    at: new Date().toISOString(),
    passed: checks.length,
    scope: '临时数据、本机模拟供应商；未调用真实模型',
    checks,
  };
  fs.mkdirSync('docs/evidence', { recursive: true });
  fs.writeFileSync('docs/evidence/agent-checks.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await mcp?.close();
  server?.kill();
  mock.closeAllConnections();
  mock.close();
  await new Promise((r) => setTimeout(r, 600));
  if (path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(dir, { recursive: true, force: true });
}
