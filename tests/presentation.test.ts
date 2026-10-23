import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed, exampleReview } from '../lib/seed';
import { normalizeReview } from '../lib/domain';
import {
  effectiveMode,
  callCount,
  recommendation,
  staleReason,
  filteredFindings,
  runFeedback,
  formatMoney,
  draftImportError,
} from '../lib/presentation';
import type { Run } from '../lib/types';
test('普通项目始终使用真实模式；示例明确可选', () => {
  assert.equal(effectiveMode({ example: false }, 'demo'), 'live');
  assert.equal(effectiveMode({ example: true }, 'demo'), 'demo');
  assert.equal(effectiveMode({ example: true }, 'live'), 'live');
});
test('用户选择的调用次数与推荐互不替换', () => {
  assert.deepEqual(
    [callCount('S0', false), callCount('S0', true), callCount('S1', true), callCount('S5', false)],
    [1, 2, 3, 2],
  );
  const t = seed().tasks[0];
  const before = JSON.stringify(t);
  assert.equal(recommendation(t, []).strategy, 'S0');
  assert.equal(
    recommendation(
      t,
      ['a', 'b'].map((slot) => ({
        slot: slot as 'a' | 'b',
        label: slot,
        model: 'mock',
        configured: true,
        inputPrice: null,
        outputPrice: null,
      })),
    ).strategy,
    'S5',
  );
  assert.equal(JSON.stringify(t), before);
});
test('建议区分来源变更、约束变化、目标片段和版本冲突', () => {
  const t = seed().tasks[0],
    f = normalizeReview(t, exampleReview(), 'r', t.currentRevision)[0];
  assert.equal(staleReason(t, f), '');
  t.sources[0].version = 2;
  assert.match(staleReason(t, f), /v1.*v2/);
  t.sources[0].version = 1;
  const r = structuredClone(t.revisions[0]);
  r.id = 'new';
  r.constraint = '预算2000';
  t.revisions.push(r);
  t.currentRevision = r.id;
  assert.match(staleReason(t, f), /约束/);
  r.constraint = t.revisions[0].constraint;
  r.blocks[1].content = '已经手改';
  assert.match(staleReason(t, f), /目标片段/);
  r.blocks = structuredClone(t.revisions[0].blocks);
  assert.match(staleReason(t, f), /版本/);
  f.status = 'accepted';
  assert.equal(staleReason(t, f), '');
});
test('默认保留待处理和暂缓，已处理可回查', () => {
  const t = seed().tasks[0],
    f = normalizeReview(t, exampleReview(), 'r', t.currentRevision);
  f[1].status = 'deferred';
  f[2].status = 'accepted';
  assert.equal(filteredFindings(f, 'pending').length, 2);
  assert.equal(filteredFindings(f, 'resolved').length, 1);
  assert.equal(filteredFindings(f, 'all').length, 3);
});
test('导入同时检查文件字节与正文长度，拒绝超限内容而不截断', () => {
  assert.equal(draftImportError(150000, '中'.repeat(50000)), '');
  assert.match(draftImportError(150003, '中'.repeat(50001)), /50,000/);
  assert.match(draftImportError(300001, '短文本'), /300 KB/);
});
test('微小费用保持六位精度；新问题为零仍呈现历史暂缓待办', () => {
  assert.equal(formatMoney(0.000001), '$0.000001');
  assert.equal(formatMoney(null), '费用待核对');
  const t = seed().tasks[0];
  t.findings = normalizeReview(t, exampleReview(), 'old', t.currentRevision);
  t.findings[0].status = 'deferred';
  assert.match(
    runFeedback({ id: 'new', state: 'succeeded', steps: [] } as unknown as Run, t.findings).detail,
    /历史仍有 3 条待处理（含暂缓）/,
  );
});
test('运行终态与没有新增建议不混为成功验证', () => {
  const r = { id: 'r', state: 'succeeded', steps: [] } as unknown as Run;
  assert.match(runFeedback(r, []).title, /没有发现新问题/);
  for (const [state, title] of [
    ['failed', '检查失败'],
    ['partial', '部分完成'],
    ['cancelled', '检查已停止'],
    ['interrupted', '检查已中断'],
    ['running', '正在检查'],
  ] as const) {
    r.state = state;
    assert.equal(runFeedback(r, []).title, title);
  }
  r.state = 'succeeded';
  const t = seed().tasks[0];
  assert.match(
    runFeedback(r, normalizeReview(t, exampleReview(), 'r', t.currentRevision)).title,
    /3 条/,
  );
});

test('部分完成反馈显示失败步骤和预算原因', () => {
  const r = {
    state: 'partial',
    steps: [
      { label: '初审', status: 'completed' },
      { label: '复核', status: 'failed', error: '保守预留金额超过预算；未发送本次请求。' },
    ],
  } as Run;
  assert.match(runFeedback(r, []).detail, /复核.*预算/);
});
