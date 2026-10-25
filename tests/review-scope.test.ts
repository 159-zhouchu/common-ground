import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../lib/seed';
import {
  defaultReviewSpec,
  reviewSpecError,
  checkedAssessments,
  scopedOutputError,
  assessmentRows,
  assessmentStaleReason,
  supersedeScopedFindings,
  prepareCriterionReview,
  reconcileReviewBlocks,
  assessmentGroups,
} from '../lib/review-scope';
import { documentInputBudget } from '../lib/document-input';
import { manifest, appendRevision, markdown } from '../lib/domain';
import { modelRequest } from '../lib/models';
import type { Assessment, Review, Run, RunOptions, Connection, Task } from '../lib/types';

const opts: RunOptions = {
  strategy: 'S0',
  selfCheck: false,
  mode: 'live',
  contextMode: 'continue',
  slot: 'a',
  budget: null,
};
function setup() {
  const task = seed().tasks[0],
    spec = defaultReviewSpec(),
    block = task.revisions[0].blocks[0];
  const assessment: Assessment = {
    criterionId: 'overall',
    verdict: 'passed',
    reason: '引用段落符合本次标准。',
    evidence: [{ blockId: block.id, sourceId: '', quote: block.content.slice(0, 12) }],
  };
  const review: Review = {
    summary: '仅针对本项',
    findings: [],
    questions: [],
    assessments: [assessment],
  };
  const run = {
    ...opts,
    id: 'review-1',
    baseRevision: task.currentRevision,
    reviewSpec: spec,
    assessments: [assessment],
    reviewBasis: {
      goal: task.goal,
      sources: task.sources.map(({ id, version }) => ({ id, version })),
    },
    state: 'succeeded',
    steps: [],
    createdAt: '',
    branch: '',
    summary: '',
    limit: 1,
    findings: [],
    deadline: 0,
  } as Run;
  return { task, spec, block, assessment, review, run };
}
test('定向范围验证拒绝空标准、重复项、已删段落与含混范围', () => {
  const { task, spec } = setup();
  assert.equal(reviewSpecError(spec, task), '');
  assert.ok(reviewSpecError({ ...spec, criteria: [{ ...spec.criteria[0], standard: ' ' }] }, task));
  assert.ok(reviewSpecError({ ...spec, criteria: [spec.criteria[0], spec.criteria[0]] }, task));
  assert.ok(reviewSpecError({ ...spec, mode: 'blocks' }, task));
  assert.ok(reviewSpecError({ ...spec, mode: 'blocks', blockIds: ['deleted'] }, task));
  assert.ok(reviewSpecError({ ...spec, mode: 'focus', focus: ' ' }, task));
  assert.ok(reviewSpecError({ ...spec, focus: '不应隐藏的方向' }, task));
});
test('没有建议不等于通过；伪造、范围外与空白依据均降为证据不足', () => {
  const { task, spec, block, review } = setup();
  assert.equal(checkedAssessments(task, spec, review)[0].verdict, 'passed');
  for (const evidence of [
    [],
    [{ blockId: block.id, sourceId: '', quote: '编造原文' }],
    [{ blockId: block.id, sourceId: task.sources[0].id, quote: ' ' }],
  ]) {
    assert.equal(
      checkedAssessments(task, spec, {
        ...review,
        assessments: [{ ...review.assessments![0], evidence }],
      })[0].verdict,
      'insufficient',
    );
  }
  const target = { ...spec, mode: 'blocks' as const, blockIds: [task.revisions[0].blocks[1].id] };
  assert.equal(checkedAssessments(task, target, review)[0].verdict, 'insufficient');
});

test('双填引用 ID 仅保留精确命中的位置；补丁兜底必须唯一定位且仅用于需修改项', () => {
  const { task, spec, block, assessment, review } = setup();
  assessment.evidence[0].sourceId = task.sources[0].id;
  let checked = checkedAssessments(task, spec, review)[0];
  assert.equal(checked.verdict, 'passed');
  assert.equal(checked.evidence[0].sourceId, '');
  assessment.evidence[0].quote = task.sources[0].text.slice(0, 15);
  checked = checkedAssessments(task, spec, review)[0];
  assert.equal(checked.evidence[0].blockId, '');
  assert.equal(checked.evidence[0].sourceId, task.sources[0].id);
  assessment.evidence = [];
  const before = block.content.slice(0, 12);
  review.findings = [
    { criterionId: 'overall', blockId: block.id, before } as Review['findings'][number],
  ];
  assert.equal(checkedAssessments(task, spec, review)[0].verdict, 'insufficient');
  assessment.verdict = 'needs_revision';
  assert.equal(checkedAssessments(task, spec, review)[0].verdict, 'needs_revision');
  assert.equal(
    checkedAssessments(task, { ...spec, mode: 'blocks', blockIds: ['other'] }, review)[0].verdict,
    'insufficient',
  );
  block.content = before + before;
  assert.equal(checkedAssessments(task, spec, review)[0].verdict, 'insufficient');
});

test('单项复查保留验收清单；满额时拒绝丢项；段落删除不自动扩大审查范围', () => {
  const { spec, block } = setup();
  const second = { id: 'budget', title: '预算', standard: '合计正确' };
  spec.criteria.push(second);
  const target = { ...spec, mode: 'focus' as const, focus: '税费', criteria: [second] };
  const prepared = prepareCriterionReview(spec, target)!;
  assert.equal(prepared.criteria.length, 2);
  assert.equal(prepared.focus, '税费');
  assert.deepEqual(spec.criteria, prepared.criteria);
  while (spec.criteria.length < 6)
    spec.criteria.push({ ...second, id: String(spec.criteria.length) });
  assert.equal(
    prepareCriterionReview(spec, { ...target, criteria: [{ ...second, id: 'missing' }] }),
    null,
  );
  const cleaned = reconcileReviewBlocks(
    { ...spec, mode: 'blocks', blockIds: [block.id, 'deleted'] },
    [block],
  );
  assert.deepEqual(cleaned.blockIds, [block.id]);
  const empty = reconcileReviewBlocks(cleaned, []);
  assert.equal(empty.mode, 'blocks');
  assert.deepEqual(empty.blockIds, []);
});
test('遗漏与重复验收项被拒绝；局部修改不能越界', () => {
  const { task, spec, review } = setup();
  assert.ok(scopedOutputError(spec, { ...review, assessments: [] }));
  assert.ok(
    scopedOutputError(spec, {
      ...review,
      assessments: [...review.assessments!, ...review.assessments!],
    }),
  );
  const target = { ...spec, mode: 'blocks' as const, blockIds: [task.revisions[0].blocks[0].id] };
  assert.ok(
    scopedOutputError(target, {
      ...review,
      findings: [{ blockId: task.revisions[0].blocks[1].id } as Review['findings'][number]],
    }),
  );
});
test('单项复查只替换同标准同范围结论，失败与部分完成保留此前结论', () => {
  const { task, spec, run } = setup();
  spec.criteria.push({ id: 'budget', title: '预算', standard: '合计正确' });
  run.assessments!.push({
    ...run.assessments![0],
    criterionId: 'budget',
    verdict: 'needs_revision',
  });
  task.runs = [run];
  const recheck = structuredClone(run);
  recheck.id = 'review-2';
  recheck.reviewSpec!.criteria = [spec.criteria[1]];
  recheck.assessments = [{ ...run.assessments![1], verdict: 'passed' }];
  task.runs.push(recheck);
  assert.equal(assessmentRows(task).length, 2);
  assert.ok(assessmentRows(task).every((r) => r.assessment.verdict === 'passed'));
  const failed = {
    ...recheck,
    id: 'failed',
    state: 'partial' as const,
    assessments: [{ ...recheck.assessments[0], verdict: 'insufficient' as const }],
  };
  task.runs.push(failed);
  assert.ok(assessmentRows(task).every((r) => r.assessment.verdict === 'passed'));
  const otherScope = structuredClone(recheck);
  otherScope.id = 'other';
  otherScope.reviewSpec!.mode = 'focus';
  otherScope.reviewSpec!.focus = '只看税费';
  task.runs.push(otherScope);
  assert.equal(assessmentRows(task).length, 3);
  const groups = assessmentGroups(task, 'live', spec);
  assert.equal(groups.primary.length, 2);
  assert.equal(groups.history.length, 1);
  assert.equal(groups.current, true);
  const fallback = assessmentGroups(task, 'live', { ...spec, mode: 'focus', focus: '另一方向' });
  assert.equal(fallback.primary.length, 1);
  assert.equal(fallback.primary[0].run.id, otherScope.id);
});
test('A、B、再查 A 时最近结论来自最新运行，旧同标准结果不抢占排序', () => {
  const { task, spec, run } = setup();
  const a = structuredClone(run);
  a.id = 'first-a';
  const b = structuredClone(run);
  b.id = 'middle-b';
  b.reviewSpec = { ...spec, mode: 'focus', focus: '只看预算' };
  const latestA = structuredClone(a);
  latestA.id = 'latest-a';
  latestA.reviewSpec!.criteria.push({ id: 'budget', title: '预算', standard: '合计正确' });
  latestA.assessments!.push({ ...latestA.assessments![0], criterionId: 'budget' });
  const failed = { ...b, id: 'failed', state: 'failed' as const };
  task.runs = [a, b, latestA, failed];
  assert.deepEqual(
    assessmentRows(task).map((r) => r.run.id),
    ['latest-a', 'latest-a', 'middle-b'],
  );
  const groups = assessmentGroups(task, 'live', { ...spec, mode: 'focus', focus: '全新问题' });
  assert.equal(groups.current, false);
  assert.equal(groups.primary.length, 2);
  assert.ok(groups.primary.every((r) => r.run.id === latestA.id));
  assert.deepEqual(
    groups.history.map((r) => r.run.id),
    ['middle-b'],
  );
});

test('修改、恢复旧文稿或更新材料后结论待复核，原结论仍可追溯', () => {
  const { task, run } = setup();
  assert.equal(assessmentStaleReason(task, run), '');
  const old = structuredClone(task.revisions[0]);
  appendRevision(task, old.blocks, old.constraint + '新约束', '编辑', old.id);
  assert.ok(assessmentStaleReason(task, run));
  appendRevision(task, old.blocks, old.constraint, '恢复', task.currentRevision);
  assert.ok(assessmentStaleReason(task, run));
  task.currentRevision = old.id;
  task.sources[0].version++;
  assert.ok(assessmentStaleReason(task, run));
  task.runs = [run];
  assert.match(markdown(task, true), /通过（待复核）/);
});

test('复查只将同范围同标准的旧建议移入历史，不改其他项与人工决定', () => {
  const { task, run, spec } = setup();
  spec.criteria.push({ id: 'budget', title: '预算', standard: '合计正确' });
  task.runs = [run];
  task.findings = [
    { id: 'a', criterionId: 'overall', runId: run.id, status: 'pending', stale: false },
    { id: 'b', criterionId: 'budget', runId: run.id, status: 'deferred', stale: false },
    { id: 'c', criterionId: 'budget', runId: run.id, status: 'accepted', stale: false },
  ] as Task['findings'];
  const recheck = { ...run, id: 'new', reviewSpec: { ...spec, criteria: [spec.criteria[1]] } };
  supersedeScopedFindings(task, { ...recheck, state: 'partial' });
  assert.ok(task.findings.every((f) => !f.stale));
  supersedeScopedFindings(task, {
    ...recheck,
    reviewSpec: { ...recheck.reviewSpec, focus: '另一范围', mode: 'focus' },
  });
  assert.ok(task.findings.every((f) => !f.stale));
  supersedeScopedFindings(task, recheck);
  assert.equal(task.findings[0].stale, false);
  assert.equal(task.findings[1].stale, true);
  assert.equal(task.findings[1].supersededBy, 'new');
  assert.equal(task.findings[1].status, 'deferred');
  assert.equal(task.findings[2].stale, false);
});
test('定向审查设置计入预检字节且完整背景仍可见，含两路比较和前序余量', () => {
  const { task, spec } = setup();
  spec.mode = 'blocks';
  spec.blockIds = [task.revisions[0].blocks[0].id];
  const c: Connection = {
    connectionId: 'mock',
    enabled: true,
    createdAt: null,
    updatedAt: null,
    label: 'mock',
    baseURL: 'http://127.0.0.1:1',
    apiKey: 'NOT_SENT',
    model: 'mock',
    protocol: 'responses',
    structured: true,
    inputPrice: null,
    outputPrice: null,
  };
  for (const strategy of ['S0', 'S1', 'S5'] as const) {
    const budget = documentInputBudget(task, {
      ...opts,
      strategy,
      reviewSpec: spec,
      selfCheck: true,
    });
    for (const step of budget.steps) {
      const req = modelRequest(c, manifest(task, 'continue', undefined, spec), step.duty);
      assert.equal(req.inputBytes, step.bytes);
      assert.ok('input' in req.body);
      assert.equal(
        JSON.parse(req.body.input[0].content).input.blocks.length,
        task.revisions[0].blocks.length,
      );
      assert.match(req.body.instructions, /不能扩大审查范围/);
    }
  }
});
