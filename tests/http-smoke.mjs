import { freePort, waitForInstance } from './local-server.mjs';
// Production-server integration in an isolated temporary workspace. No paid API calls.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Document, Paragraph, Packer } from 'docx';
import mammoth from 'mammoth';
import http from 'node:http';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'common-ground-http-'));
assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
const port = await freePort(),
  instance = randomUUID(),
  base = 'http://127.0.0.1:' + port;
const server = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CG_DATA_DIR: dir,
      CG_INSTANCE_ID: instance,
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
const checks = [];
const probeRequests = [];
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  probeRequests.push({ url: req.url, body: JSON.parse(raw), auth: req.headers.authorization });
  res.setHeader('Content-Type', 'application/json');
  if (req.url.startsWith('/denied')) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'MOCK_SECRET_MUST_NOT_LEAK' }));
    return;
  }
  res.end(
    JSON.stringify({
      status: 'completed',
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({ summary: 'OK', findings: [], questions: [] }),
            },
          ],
        },
      ],
      choices: [
        {
          finish_reason: 'stop',
          message: { content: JSON.stringify({ summary: 'OK', findings: [], questions: [] }) },
        },
      ],
      usage: { input_tokens: 70, output_tokens: 20, prompt_tokens: 70, completion_tokens: 20 },
    }),
  );
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const provider = 'http://127.0.0.1:' + mock.address().port;
async function call(route, body, expect = 200) {
  const response = await fetch(base + '/api/' + route, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', Origin: base } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  assert.equal(response.status, expect, JSON.stringify(data));
  return data;
}
try {
  await waitForInstance(base, instance, server, () => log);
  const home = await fetch(base);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  checks.push('首页禁止嵌入与 MIME 嗅探');
  async function rawRequest(method, route, headers = {}, chunks = []) {
    return new Promise((resolve, reject) => {
      const request = http.request(base + '/api/' + route, { method, headers }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      for (const chunk of chunks) request.write(chunk);
      request.end();
    });
  }
  assert.equal(await rawRequest('GET', 'workspace', { Host: 'evil.example' }), 403);
  assert.equal(
    await rawRequest(
      'POST',
      'task',
      { Host: 'evil.example', Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      ['{}'],
    ),
    403,
  );
  assert.equal(await rawRequest('GET', 'workspace', { Origin: 'null' }), 403);
  checks.push('恶意 Host 的 GET/POST 及 null Origin 返回 403');
  for (const [route, size] of [
    ['task', 600001],
    ['material', 6 * 1024 * 1024 + 1],
  ])
    assert.equal(
      await rawRequest('POST', route, { 'Content-Type': 'application/json' }, [
        Buffer.alloc(size, 32),
      ]),
      413,
    );
  checks.push('无 Content-Length 的超大 JSON 与材料上传返回 413');
  let ws = await call('workspace');
  const sample = ws.tasks[0];
  const run = await call('runs', {
    taskId: sample.id,
    strategy: 'S5',
    selfCheck: false,
    mode: 'demo',
    contextMode: 'continue',
    slot: 'a',
    budget: null,
    idempotencyKey: randomUUID(),
  });
  for (let i = 0; i < 50; i++) {
    ws = await call('workspace');
    if (ws.tasks[0].runs[0].state !== 'running') break;
    await new Promise((r) => setTimeout(r, 40));
  }
  let task = ws.tasks[0];
  assert.equal(task.findings.length, 3);
  assert.equal(task.runs[0].state, 'succeeded');
  checks.push('示例运行生成三项预置问题，正文未自动写入');
  const budget = task.findings.find((f) => f.kind === '计算错误');
  const rev = await call('patch', {
    taskId: task.id,
    id: budget.id,
    base: task.currentRevision,
    decision: 'accepted',
  });
  assert.ok(rev.blocks.find((b) => b.id === 'budget').content.includes('2510'));
  checks.push('采用预算修订创建 v2，保留其他段落');
  await call(
    'patch',
    { taskId: task.id, id: budget.id, base: task.currentRevision, decision: 'accepted' },
    409,
  );
  checks.push('重复或旧版修改被拒绝');
  const restored = await call('restore', {
    taskId: task.id,
    revision: task.currentRevision,
    base: rev.id,
  });
  assert.equal(restored.number, 3);
  assert.ok(restored.blocks.find((b) => b.id === 'budget').content.includes('2310'));
  checks.push('恢复旧稿生成 v3，不删除历史');
  const created = await call('task', {
    title: '接口验收项目',
    goal: '检查资料',
    content: '这是需要评审的原稿。\n\n保留这段内容。',
    constraint: '预算不超过 2000 元',
  });
  assert.equal(created.revisions[0].blocks.length, 2);
  checks.push('新建项目及用户原稿持久保存');
  const doc = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph('供应商原始说明'),
            new Paragraph('价格 1800 元，交付周期 5 天。'),
          ],
        },
      ],
    }),
  );
  const form = new FormData();
  form.set('taskId', created.id);
  form.set(
    'file',
    new File([doc], '供应说明.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
  );
  let response = await fetch(base + '/api/material', {
    method: 'POST',
    body: form,
    headers: { Origin: base },
  });
  assert.equal(response.status, 200);
  const source = await response.json();
  assert.ok(source.text.includes('1800'));
  assert.ok(source.warning);
  checks.push('真实 DOCX 上传、正文提取与解析边界提示');
  const replacement = new FormData();
  replacement.set('taskId', created.id);
  replacement.set('replaceId', source.id);
  replacement.set('file', new File(['新报价：1900 元。'], '更新报价.txt'));
  response = await fetch(base + '/api/material', {
    method: 'POST',
    body: replacement,
    headers: { Origin: base },
  });
  const replaced = await response.json();
  assert.equal(replaced.version, 2);
  assert.ok(replaced.history[0].text.includes('1800'));
  checks.push('材料替换保留旧版，并创建重新核查提醒');
  response = await fetch(base + `/api/export?taskId=${sample.id}&format=docx&review=true`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const exported = Buffer.from(await response.arrayBuffer());
  const extracted = await mammoth.extractRawText({ buffer: exported });
  assert.ok(extracted.value.includes('问题与依据记录'));
  assert.ok(extracted.value.includes('2310'));
  assert.ok(extracted.value.includes('税费及预算'));
  assert.ok(extracted.value.includes('已接受'));
  assert.ok(extracted.value.includes('北京时间'));
  assert.ok(!extracted.value.includes('pending'));
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
  checks.push('DOCX 导出可重新读取，正文、版本和问题附录一致');
  response = await fetch(base + `/api/export?taskId=${sample.id}&format=md&review=true`);
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('v3'));
  checks.push('Markdown 导出绑定当前 v3');
  response = await fetch(
    base + `/api/export?taskId=${sample.id}&revision=${rev.id}&format=md&review=false`,
  );
  const bound = await response.text();
  assert.ok(bound.includes('v2'));
  assert.ok(bound.includes('2510'));
  checks.push('显式指定旧版本导出不被当前版本指针替换');
  const parsed = await call('task', {
    title: '中文标题/导出',
    goal: '',
    content: '# 标题\n第一段\n\n## 第二节\n保留原文',
    constraint: '',
  });
  assert.equal(parsed.revisions[0].blocks[0].title, '标题');
  assert.equal(parsed.revisions[0].blocks[0].content, '第一段');
  const inserted = [
    ...parsed.revisions[0].blocks,
    { id: randomUUID(), title: '新增段落', content: '新增内容', origin: 'user' },
  ];
  const added = await call('save', {
    taskId: parsed.id,
    base: parsed.currentRevision,
    blocks: inserted,
    constraint: '',
  });
  assert.equal(added.blocks.length, 3);
  const merged = await call('save', {
    taskId: parsed.id,
    base: added.id,
    blocks: [
      {
        ...added.blocks[0],
        title: '改后标题',
        content: added.blocks[0].content + '\n\n' + added.blocks[1].content,
      },
      added.blocks[2],
    ],
    constraint: '',
  });
  assert.equal(merged.blocks.length, 2);
  assert.equal(merged.blocks[0].title, '改后标题');
  await call(
    'save',
    { taskId: parsed.id, base: added.id, blocks: added.blocks, constraint: '' },
    409,
  );
  response = await fetch(base + '/api/export?taskId=' + parsed.id + '&format=md');
  assert.match(
    decodeURIComponent(response.headers.get('content-disposition')),
    /共桌-中文标题_导出-v3.md/,
  );
  checks.push('Markdown 标题导入、标题编辑、新增合并、版本冲突与中文下载名');
  response = await fetch(base + '/api/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' },
    body: JSON.stringify({ title: 'cross-origin' }),
  });
  assert.equal(response.status, 403);
  checks.push('跨来源写入被拒绝');
  ws = await call('workspace');
  assert.equal(ws.tasks.length, 3);
  assert.ok(!JSON.stringify(ws.connections).includes('apiKey'));
  assert.ok(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8').includes('接口验收项目'));
  checks.push('刷新读取服务端文件，连接响应不含密钥字段');
  const settings = await call('settings');
  assert.equal(settings.length, 2);
  const configured = settings.map((c) => ({
    ...c,
    apiKey: c.slot === 'a' ? 'MOCK_SECRET_MUST_NOT_LEAK' : '',
    model: c.slot === 'a' ? 'local-probe' : '',
    baseURL: provider + '/v1',
    inputPrice: 1,
    outputPrice: 2,
  }));
  await call('settings', { connections: configured });
  assert.equal(probeRequests.length, 0);
  let safe = await call('settings');
  assert.ok(safe[0].hasKey);
  assert.ok(!JSON.stringify(safe).includes('MOCK_SECRET'));
  assert.ok(!('apiKey' in safe[0]));
  checks.push('API 配置可只连接 A；保存不发模型请求，读取不返回密钥');
  const probe = await call('connections/test', {
    connection: { ...safe[0], apiKey: '' },
    confirmCall: true,
  });
  assert.ok(probe.success);
  assert.equal(probe.input, 70);
  assert.equal(probe.output, 20);
  assert.equal(probe.cost, 0.00011);
  assert.equal(probeRequests.length, 1);
  assert.equal(probeRequests[0].body.max_output_tokens, 256);
  assert.equal(probeRequests[0].auth, 'Bearer MOCK_SECRET_MUST_NOT_LEAK');
  assert.ok(!JSON.stringify(probeRequests[0].body).includes('校园低碳'));
  assert.ok(!JSON.stringify(probe).includes('MOCK_SECRET'));
  checks.push('连接测试复用服务端密钥，只发测试文字，返回真实模拟用量与耗时');
  await call(
    'connections/test',
    { connection: { ...safe[0], apiKey: '', baseURL: provider + '/other' }, confirmCall: true },
    400,
  );
  assert.equal(probeRequests.length, 1);
  await call(
    'connections/test',
    {
      connection: { ...safe[0], apiKey: '', baseURL: provider + '/v1/responses' },
      confirmCall: true,
    },
    400,
  );
  assert.equal(probeRequests.length, 1);
  checks.push('更换地址不静默复用密钥；误填完整端点在发送前被拒绝');
  const failed = await call(
    'connections/test',
    {
      connection: {
        ...safe[0],
        apiKey: 'MOCK_SECRET_MUST_NOT_LEAK',
        baseURL: provider + '/denied',
      },
      confirmCall: true,
    },
    502,
  );
  assert.equal(failed.code, 'PROVIDER_ERROR');
  assert.ok(!JSON.stringify(failed).includes('MOCK_SECRET'));
  checks.push('鉴权失败显示安全错误，不透传供应商原文或密钥');
  const chat = await call('connections/test', {
    connection: { ...safe[0], apiKey: '', protocol: 'chat' },
    confirmCall: true,
  });
  assert.ok(chat.success);
  assert.ok(probeRequests.at(-1).url.endsWith('/chat/completions'));
  assert.equal(probeRequests.at(-1).body.max_tokens, 256);
  const history = fs.readFileSync(path.join(dir, 'connection-tests.json'), 'utf8');
  assert.ok(!history.includes('MOCK_SECRET'));
  assert.equal(JSON.parse(history).length, 3);
  checks.push('兼容 Chat 协议测试通过；独立测试日志记录费用和失败且不含密钥');
  await call('settings', {
    connections: safe.map((c) => ({ ...c, apiKey: '', clearKey: c.slot === 'a' })),
  });
  safe = await call('settings');
  assert.equal(safe[0].hasKey, false);
  await call(
    'connections/test',
    { connection: { ...safe[0], apiKey: '' }, confirmCall: true },
    400,
  );
  checks.push('清除已保存密钥后，连接测试被阻止');
  const originalCalls = probeRequests.length;
  await call('connections/save', {
    connection: { ...safe[0], label: '保留密钥测试', apiKey: 'LOCAL_TEST_ONLY', model: 'local-0' },
  });
  let copied = await call('connections/copy', { connectionId: safe[0].connectionId });
  const duplicate = copied.at(-1);
  assert.notEqual(duplicate.connectionId, safe[0].connectionId);
  assert.equal(duplicate.hasKey, false);
  assert.equal(duplicate.model, 'local-0');
  for (let i = copied.length; i < 10; i++)
    await call('connections/save', {
      connection: {
        connectionId: 'dynamic-' + i,
        label: '连接 ' + i,
        baseURL: provider + '/v1',
        apiKey: 'LOCAL_TEST_ONLY',
        model: 'local-' + i,
        enabled: true,
        protocol: 'responses',
        structured: true,
        inputPrice: null,
        outputPrice: null,
      },
    });
  safe = await call('settings');
  assert.equal(safe.length, 10);
  assert.equal(probeRequests.length, originalCalls);
  assert.ok(!JSON.stringify(safe).includes('LOCAL_TEST_ONLY'));
  checks.push('动态配置保存、复制均不调用模型；副本稳定 ID 且不含密钥；可读满 10 个连接');
  const extra = { ...safe[9], connectionId: 'eleventh', apiKey: '' };
  await call('connections/save', { connection: extra }, 400);
  await call('settings', { connections: [...safe, extra] }, 400);
  await call('connections/copy', { connectionId: safe[0].connectionId }, 400);
  assert.equal((await call('settings')).length, 10);
  checks.push('第 11 个连接、批量超限和满额复制均被后端阻止');
  await call(
    'message',
    {
      taskId: created.id,
      connectionId: '',
      text: '空选择不能回退旧 A',
      idempotencyKey: randomUUID(),
    },
    400,
  );
  assert.equal(probeRequests.length, originalCalls);
  const selected = safe[9];
  await call('connections/save', { connection: { ...selected, apiKey: '', enabled: false } });
  await call(
    'message',
    {
      taskId: created.id,
      connectionId: selected.connectionId,
      text: '不应发送',
      idempotencyKey: randomUUID(),
    },
    400,
  );
  assert.equal(probeRequests.length, originalCalls);
  await call('connections/save', { connection: { ...selected, apiKey: '', enabled: true } });
  const discussion = await call('message', {
    taskId: created.id,
    connectionId: selected.connectionId,
    text: '只向所选连接讨论',
    idempotencyKey: randomUUID(),
  });
  let discussionRun;
  for (let i = 0; i < 100; i++) {
    const s = await call('workspace');
    discussionRun = s.tasks
      .find((t) => t.id === created.id)
      .runs.find((r) => r.id === discussion.id);
    if (discussionRun.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(discussionRun.state, 'succeeded');
  assert.equal(probeRequests.length, originalCalls + 1);
  assert.equal(probeRequests.at(-1).body.model, selected.model);
  assert.equal(discussionRun.steps[0].connectionId, selected.connectionId);
  checks.push('讨论只调用指定动态连接；停用后不自动改用其他模型');
  await call('connections/save', { connection: { ...selected, label: '重新命名', apiKey: '' } });
  await call('connections/delete', { connectionId: selected.connectionId });
  ws = await call('workspace');
  const historical = ws.tasks
    .find((t) => t.id === created.id)
    .runs.find((r) => r.id === discussion.id);
  assert.equal(historical.steps[0].connectionSnapshot.label, selected.label);
  assert.equal(historical.steps[0].model, selected.model);
  assert.ok(!JSON.stringify(ws).includes('LOCAL_TEST_ONLY'));
  assert.ok(!JSON.stringify(historical).includes('apiKey'));
  checks.push('重命名及删除不破坏历史模型快照、成果或版本；接口不返回密钥');
  const full = await call('workspace'),
    summaryResponse = await fetch(base + '/api/workspace?view=summary'),
    summary = await summaryResponse.json();
  assert.equal(
    (
      await fetch(base + '/api/workspace?view=summary', {
        headers: { 'If-None-Match': summaryResponse.headers.get('etag') },
      })
    ).status,
    304,
  );
  for (const t of full.tasks) {
    const small = summary.tasks.find((x) => x.id === t.id);
    assert.equal(small.revisions.length, t.revisions.length);
    assert.deepEqual(
      small.revisions.find((r) => r.id === t.currentRevision).blocks,
      t.revisions.find((r) => r.id === t.currentRevision).blocks,
    );
    assert.ok(
      small.revisions.filter((r) => r.id !== t.currentRevision).every((r) => r.blocks.length === 0),
    );
  }
  const detail = await call('task-detail?taskId=' + sample.id);
  assert.equal(detail.revisions.length, 3);
  assert.ok(detail.revisions[0].blocks.length);
  checks.push('摘要保留版本元信息、ETag 返回 304、历史详情按需读取');
  await call('task/rename', {
    taskId: created.id,
    title: '改名后的项目',
    base: created.currentRevision,
  });
  assert.equal((await call('task-detail?taskId=' + created.id)).title, '改名后的项目');
  await call('task/archive', { taskId: created.id, base: 'stale' }, 409);
  const archivedSnapshot = await call('task-detail?taskId=' + created.id);
  await call('task/archive', { taskId: created.id, base: created.currentRevision });
  const afterArchive = await call('workspace?view=summary');
  assert.ok(!afterArchive.tasks.some((t) => t.id === created.id));
  assert.deepEqual(afterArchive.archivedTasks, [{ id: created.id, title: '改名后的项目' }]);
  await call('task-detail?taskId=' + created.id, undefined, 404);
  await call('task/restore', { taskId: created.id });
  assert.deepEqual(await call('task-detail?taskId=' + created.id), archivedSnapshot);
  await call('task/restore', { taskId: created.id }, 404);
  checks.push('项目改名、冲突拦截、回收列表最小化与完整恢复');
  const messages = (await call('task-detail?taskId=' + created.id)).messages;
  assert.deepEqual(
    messages.map((m) => m.actor),
    ['user', 'assistant'],
  );
  assert.equal(messages[0].content, '只向所选连接讨论');
  checks.push('HTTP 讨论成功后成对写入，未配置请求不留下孤立消息');
  const report = {
    at: new Date().toISOString(),
    scope: '本机生产构建的隔离 HTTP 集成测试；没有真实模型调用或用户效果评测',
    passed: checks.length,
    checks,
  };
  fs.mkdirSync('docs/evidence', { recursive: true });
  fs.writeFileSync('docs/evidence/http-checks.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  mock.close();
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
  if (path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(dir, { recursive: true, force: true });
}
