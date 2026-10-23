import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed, exampleReview } from '../lib/seed';
import {
  manifest,
  normalizeReview,
  applyFinding,
  current,
  appendRevision,
  impactFor,
  plan,
  markdown,
} from '../lib/domain';
import { modelRequest, reserveCost } from '../lib/models';
import type { Connection, RunOptions } from '../lib/types';
const options: RunOptions = {
  strategy: 'S1',
  mode: 'live',
  contextMode: 'source_only',
  selfCheck: false,
  slot: 'a',
  budget: null,
};
test('独立输入排除当前正文及历史回答，保留获准原文和用户约束', () => {
  const t = seed().tasks[0];
  t.messages.push({ id: 'msg', actor: 'assistant', content: 'SECRET_OLD_ANSWER', createdAt: '' });
  const m = manifest(t, 'source_only');
  assert.equal(m.blocks.length, 0);
  assert.equal(m.messages.length, 0);
  assert.equal(m.sources.length, 2);
  assert.ok(!JSON.stringify(m).includes('SECRET_OLD_ANSWER'));
  assert.equal(m.hash.length, 64);
  assert.ok(manifest(t, 'continue').blocks.length > 0);
});
test('采用建议仅替换授权的精确片段，并保留旧版、相邻段落和约束', () => {
  const t = seed().tasks[0],
    before = structuredClone(current(t));
  t.findings = normalizeReview(t, exampleReview(), 'r', before.id);
  const next = applyFinding(t, t.findings[0].id, before.id);
  assert.equal(next.number, 2);
  assert.ok(next.blocks[1].content.includes('2510'));
  assert.deepEqual(next.blocks[0], before.blocks[0]);
  assert.deepEqual(next.blocks[2], before.blocks[2]);
  assert.equal(next.constraint, before.constraint);
  assert.deepEqual(t.revisions[0], before);
  assert.equal(t.findings[0].status, 'accepted');
  assert.equal(t.findings[1].baseRevision, next.id);
});
test('旧基准、重复采用和来源变化均不能静默覆盖当前成果', () => {
  const t = seed().tasks[0];
  t.findings = normalizeReview(t, exampleReview(), 'r', t.currentRevision);
  const base = t.currentRevision;
  applyFinding(t, t.findings[0].id, base);
  assert.throws(() => applyFinding(t, t.findings[0].id, base));
  assert.throws(() => appendRevision(t, current(t).blocks, '预算 2000', 'old', base));
  t.sources[1].version++;
  assert.throws(() => applyFinding(t, t.findings[1].id, t.currentRevision));
});
test('无法唯一定位的 before 和不存在的引用不得伪装为可定位', () => {
  const t = seed().tasks[0];
  const review = exampleReview();
  review.findings[0].quote = '不存在的材料句子';
  const fs = normalizeReview(t, review, 'r', t.currentRevision);
  assert.equal(fs[0].quoteValid, false);
  t.findings = fs;
  current(t).blocks[1].content += '\n' + fs[0].before;
  assert.throws(() => applyFinding(t, fs[0].id, t.currentRevision));
});
test('约束变化使旧建议过时，并将预算影响与未知影响分开记录', () => {
  const t = seed().tasks[0];
  const old = current(t);
  t.findings = normalizeReview(t, exampleReview(), 'r', old.id);
  appendRevision(t, old.blocks, '预算不超过 2000 元', 'constraint', old.id);
  assert.ok(t.findings.every((f) => f.stale));
  const effects = impactFor(t, old.constraint, '预算不超过 2000 元');
  assert.equal(effects.find((e) => e.blockId === 'budget')?.state, 'review');
  assert.equal(effects.find((e) => e.blockId === 'outcome')?.state, 'unchecked');
});
test('步骤清单不含隐藏汇总；S0 自检与 S1 调用数可唯一确定', () => {
  assert.equal(plan(options).length, 3);
  assert.deepEqual(
    plan(options).map((s) => s.slot),
    ['a', 'b', 'a'],
  );
  assert.equal(plan({ ...options, strategy: 'S0', selfCheck: true }).length, 2);
  assert.equal(plan({ ...options, strategy: 'S0', selfCheck: false }).length, 1);
  assert.equal(plan({ ...options, strategy: 'S5' }).length, 2);
});
test('两种模型协议均带上限与结构化 schema，未知价格不编造费用', () => {
  const c: Connection = {
    connectionId: 'test-a',
    enabled: true,
    createdAt: null,
    updatedAt: null,
    slot: 'a',
    label: 'A',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'not-a-real-key',
    model: 'configured-model',
    protocol: 'responses',
    structured: true,
    inputPrice: null,
    outputPrice: null,
  };
  const m = manifest(seed().tasks[0], 'continue');
  const response = modelRequest(c, m, 'answer');
  assert.equal(response.url, 'https://api.openai.com/v1/responses');
  assert.ok('max_output_tokens' in response.body);
  assert.equal(response.body.max_output_tokens, 3000);
  assert.ok('text' in response.body);
  const chat = modelRequest({ ...c, protocol: 'chat' }, m, 'answer');
  assert.ok('response_format' in chat.body);
  assert.equal(reserveCost(c, 1000, 2000), null);
  assert.ok(!JSON.stringify(response.body).includes(c.apiKey));
});
test('导出绑定当前版本；附录保留未决问题且不包含密钥', () => {
  const t = seed().tasks[0];
  t.findings = normalizeReview(t, exampleReview(), 'r', t.currentRevision);
  const text = markdown(t, true);
  assert.ok(text.includes('v1'));
  assert.ok(text.includes('问题与依据记录'));
  assert.ok(text.includes('待处理'));
  assert.ok(!text.includes('pending'));
  assert.ok(text.includes('北京时间'));
  assert.ok(!text.includes('apiKey'));
});

test('纯删除可采纳，原版本保持不变；空 before 仍拒绝', () => {
  const t = seed().tasks[0];
  t.findings = normalizeReview(t, exampleReview(), 'r', t.currentRevision);
  const f = t.findings[0],
    base = current(t),
    original = base.blocks.find((b) => b.id === f.blockId)!.content;
  f.after = '';
  applyFinding(t, f.id, base.id);
  assert.equal(
    current(t).blocks.find((b) => b.id === f.blockId)!.content,
    original.replace(f.before, ''),
  );
  assert.equal(base.blocks.find((b) => b.id === f.blockId)!.content, original);
});
test('约束、材料或段落失效后，多次无关保存或恢复不能复活旧建议', () => {
  for (const change of ['constraint', 'source', 'block']) {
    const t = seed().tasks[0];
    t.findings = normalizeReview(t, exampleReview(), 'r', t.currentRevision);
    const f = t.findings[0],
      base = structuredClone(current(t));
    if (change === 'source') {
      t.sources.find((s) => s.id === f.sourceId)!.version++;
      f.stale = true;
    }
    const blocks = structuredClone(base.blocks);
    if (change === 'block') blocks.find((b) => b.id === f.blockId)!.content += '补充上下文';
    appendRevision(
      t,
      blocks,
      change === 'constraint' ? '新约束' : base.constraint,
      'change',
      t.currentRevision,
    );
    for (let i = 0; i < 2; i++)
      appendRevision(t, current(t).blocks, current(t).constraint, 'unrelated', t.currentRevision);
    appendRevision(t, base.blocks, base.constraint, 'restore', t.currentRevision);
    assert.equal(f.stale, true, change);
    assert.throws(() => applyFinding(t, f.id, t.currentRevision));
  }
});

test('修订正文按字面写入 dollar 替换符，不解释为正则替换模板', () => {
  const t = seed().tasks[0];
  t.findings = normalizeReview(t, exampleReview(), 'r', t.currentRevision);
  const f = t.findings[0];
  f.after = '$& / $1 / $$';
  applyFinding(t, f.id, t.currentRevision);
  assert.ok(
    current(t)
      .blocks.find((b) => b.id === f.blockId)!
      .content.includes(f.after),
  );
});
