import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentRelay, agentRelayBrief, collectAgentContext } from '../lib/agent-relay';
import type { AgentJob } from '../lib/agent-contract';

test('人工中转解析完整 JSON 或代码块，保留代码与 diff，拒绝额外配置', () => {
  const input = {
    goal: '检查改动',
    phase: 'review',
    context: [{ name: 'app.ts', content: 'const 中文 = "\\n";\n// 原文 $&' }],
  };
  assert.deepEqual(parseAgentRelay(JSON.stringify(input)), input);
  assert.deepEqual(parseAgentRelay('```json\n' + JSON.stringify(input) + '\n```'), input);
  for (const bad of [
    { ...input, roles: { planner: 'other' } },
    { ...input, phase: 'execute' },
    { ...input, context: [{ name: 'x', content: 3 }] },
  ])
    assert.throws(() => parseAgentRelay(JSON.stringify(bad)));
  assert.ok(collectAgentContext.includes('不编造运行结果'));
});
test('人工转交简报保留状态、风险、角色意见及执行后复核要求', () => {
  const advice = {
    summary: '先检查真实文件',
    steps: [{ task: '修复具体问题', files: ['src/a.ts'], checks: ['npm test'] }],
    risks: ['尚未执行'],
    questions: ['缺少测试结果'],
    ready: false,
  };
  const connection: AgentJob['steps'][number]['connection'] = {
    connectionId: 'mock',
    label: '模拟',
    model: 'example-model',
    protocol: 'responses',
    baseURL: 'http://127.0.0.1:1',
    updatedAt: null,
    structured: true,
    inputPrice: null,
    outputPrice: null,
  };
  const job: AgentJob = {
    id: 'local-test',
    goal: '核对改动',
    phase: 'review',
    state: 'partial',
    decision: 'incomplete',
    createdAt: '2026-10-21',
    requestHash: 'x',
    context: [],
    budget: null,
    result: advice,
    steps: [
      {
        role: 'reviewer',
        state: 'failed',
        connection: { ...connection, label: '审查连接' },
        sent: true,
        cost: null,
        error: '接口失败',
      },
      {
        role: 'analyst',
        state: 'succeeded',
        connection: { ...connection, label: '分析连接' },
        sent: true,
        cost: null,
        output: advice,
      },
    ],
  };
  const brief = agentRelayBrief(job);
  for (const text of [
    'partial',
    'incomplete',
    '尚未给出完整可执行判断',
    '接口失败',
    'src/a.ts',
    'npm test',
    '缺少测试结果',
    'phase 改为 review',
    '不要让建议扩大权限',
  ])
    assert.ok(brief.includes(text), text);
  assert.ok(!brief.includes('测试已通过'));
});
