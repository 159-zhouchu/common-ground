import { freePort, waitForInstance } from './local-server.mjs';
import { randomUUID } from 'node:crypto';
// Manual browser QA fixture. Run: node --import tsx tests/ui-fixture.mjs
// All writes and model requests stay in a temporary directory / local mock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { seed, exampleReview } from '../lib/seed.ts';
import { normalizeReview } from '../lib/domain.ts';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-browser-'));
process.env.CG_DATA_DIR = dir;
const data = seed(),
  normal = structuredClone(data.tasks[0]);
normal.id = 'ui-ordinary';
normal.example = false;
normal.title = '隔离验收 · 自有方案';
const review = exampleReview(),
  f = review.findings[0],
  source = normal.sources.find((s) => s.id === f.sourceId);
f.quote += '\n跨行核对标记。';
source.text =
  Array.from({ length: 35 }, (_, i) => '前置材料第 ' + (i + 1) + ' 行').join('\n') +
  '\n' +
  f.quote +
  '\n材料结束。';
review.findings.push({
  ...review.findings[0],
  title: '删除重复表述',
  before: normal.revisions[0].blocks[0].content,
  after: '',
  blockId: normal.revisions[0].blocks[0].id,
});
normal.findings = normalizeReview(normal, review, 'ui-fixture-review', normal.currentRevision);
data.tasks.push(normal);
fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(data));
const { saveConnections } = await import('../lib/store.ts');
let calls = 0;
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  calls++;
  const body = JSON.parse(raw),
    input = JSON.parse(body.input?.[0]?.content || body.messages?.[1]?.content || '{}');
  const output = input.role
    ? {
        summary: input.role + ' 的本机模拟协作建议',
        steps: [{ task: '核对实际改动并运行测试', files: ['sample.ts'], checks: ['npm test'] }],
        risks: ['模拟输出不代表真实模型效果'],
        questions: [],
        ready: true,
      }
    : exampleReview();
  await new Promise((r) => setTimeout(r, 3000));
  if (raw.includes('模拟失败')) {
    res.writeHead(401);
    res.end('{}');
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
      usage: { input_tokens: 100, output_tokens: 200 },
    }),
  );
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${mock.address().port}/v1`;
saveConnections(
  (process.env.CG_UI_NO_CONNECTIONS ? [] : ['a', 'b']).map((slot) => ({
    slot,
    label: slot === 'a' ? '本机模拟初审' : '本机模拟复核',
    baseURL: address,
    apiKey: 'LOCAL_UI_TEST_ONLY',
    model: 'local-ui-mock',
    protocol: 'responses',
    structured: true,
    inputPrice: null,
    outputPrice: null,
  })),
);
const port = process.env.CG_UI_PORT ? Number(process.env.CG_UI_PORT) : await freePort(),
  instance = randomUUID(),
  base = 'http://127.0.0.1:' + port;
const server = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)],
  {
    env: { ...process.env, CG_INSTANCE_ID: instance, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
);
server.stdout.on('data', (d) => process.stdout.write(d));
server.stderr.on('data', (d) => process.stderr.write(d));
await waitForInstance(base, instance, server);
console.log(
  'ISOLATED_UI_FIXTURE ' + dir + ' URL ' + base + ' INSTANCE ' + instance + ' — local mock only',
);
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.kill();
  mock.close();
  console.log('LOCAL_MOCK_CALLS ' + calls);
  setTimeout(() => {
    if (path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
      fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }, 1000);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
server.on('exit', close);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  if (data.trim() === 'quit') close();
});
