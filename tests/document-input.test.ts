import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../lib/seed';
import { manifest, plan } from '../lib/domain';
import { modelRequest } from '../lib/models';
import { documentInputBudget } from '../lib/document-input';
import type { Connection, RunOptions } from '../lib/types';

const connection: Connection = {
  connectionId: 'local-test',
  enabled: true,
  createdAt: null,
  updatedAt: null,
  label: '模拟',
  baseURL: 'http://127.0.0.1:1/v1',
  apiKey: 'NOT_SENT',
  model: 'mock',
  protocol: 'responses',
  structured: true,
  inputPrice: null,
  outputPrice: null,
};
const options: RunOptions = {
  strategy: 'S0',
  selfCheck: false,
  mode: 'live',
  contextMode: 'continue',
  slot: 'a',
  budget: null,
};
const variants: RunOptions[] = [
  ...(['continue', 'source_only'] as const).flatMap((contextMode) => [
    { ...options, contextMode },
    { ...options, contextMode, selfCheck: true },
    { ...options, contextMode, strategy: 'S1' as const },
  ]),
  { ...options, strategy: 'S5' },
];

test('页面容量与实际请求逐步字节一致，包含 UTF-8、JSON 转义、指令与清单元数据', () => {
  const task = seed().tasks[0];
  task.goal = '中文😀 "引号" \\路径\n换行\t制表';
  task.messages = Array.from({ length: 12 }, (_, i) => ({
    id: String(i),
    actor: i % 2 ? ('assistant' as const) : ('user' as const),
    content: '消息😀 ' + i,
    createdAt: '',
  }));
  const before = JSON.stringify(task);
  for (const opts of variants) {
    const budget = documentInputBudget(task, opts),
      steps = plan(opts);
    assert.equal(budget.steps.length, steps.length);
    for (const [i, step] of steps.entries()) {
      const mode = step.duty === 'compare' ? 'continue' : opts.contextMode,
        m = manifest(task, mode),
        request = modelRequest(connection, m, step.duty);
      assert.ok('input' in request.body);
      const wire = JSON.parse(request.body.input[0].content);
      assert.equal(budget.steps[i].bytes, Buffer.byteLength(request.body.input[0].content, 'utf8'));
      assert.equal(budget.steps[i].bytes, request.inputBytes);
      assert.equal(wire.input.hash.length, 64);
      assert.equal(wire.input.mode, mode);
      assert.equal(
        wire.input.blocks.length,
        mode === 'continue' ? task.revisions[0].blocks.length : 0,
      );
      assert.equal(wire.input.messages.length, mode === 'continue' ? 10 : 0);
      assert.ok(wire.duty.length > 0);
      assert.ok(
        budget.steps[i].bytes >
          Buffer.byteLength(
            JSON.stringify({
              goal: task.goal,
              constraint: m.constraint,
              sources: m.sources,
              blocks: m.blocks,
              messages: m.messages,
            }),
          ),
      );
    }
  }
  assert.equal(JSON.stringify(task), before);
});

test('80/100 KB 临界值差一字节时页面预检正确拦截，前序结果单独预留', () => {
  for (const opts of variants) {
    const task = seed().tasks[0];
    task.sources = task.sources.slice(0, 1);
    task.sources[0].text = '';
    const initial = documentInputBudget(task, opts);
    task.sources[0].text = 'x'.repeat(initial.limit - initial.bytes);
    const exact = documentInputBudget(task, opts);
    assert.equal(exact.bytes, exact.limit);
    assert.equal(exact.exceeded, false);
    assert.equal(exact.limit, exact.steps.length === 1 ? 100000 : 80000);
    assert.ok(exact.steps.every((s) => s.bytes + s.reserve <= 100000));
    task.sources[0].text += 'x';
    assert.equal(documentInputBudget(task, opts).exceeded, true);
  }
});

test('S1 原材料独立阶段不读正文，页面仍按最终比较的完整输入拦截', () => {
  const task = seed().tasks[0];
  task.revisions[0].blocks[0].content = '中'.repeat(29000);
  const budget = documentInputBudget(task, {
    ...options,
    strategy: 'S1',
    contextMode: 'source_only',
  });
  assert.equal(budget.steps[0].mode, 'source_only');
  assert.equal(budget.steps[2].mode, 'continue');
  assert.ok(budget.steps[0].bytes < 80000);
  assert.ok(budget.steps[2].bytes > 80000);
  assert.equal(budget.exceeded, true);
  assert.equal(budget.reserve, 19024);
});
