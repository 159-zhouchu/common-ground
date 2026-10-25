import { z } from 'zod';
import type { Assessment, Block, Review, ReviewSpec, Run, Task } from './types';

export const ReviewSpecSchema = z
  .object({
    mode: z.enum(['whole', 'blocks', 'focus']),
    blockIds: z.array(z.string().min(1).max(150)).max(100),
    focus: z.string().trim().max(1200),
    criteria: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            title: z.string().trim().min(1).max(120),
            standard: z.string().trim().min(1).max(1200),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();

export function defaultReviewSpec(): ReviewSpec {
  return {
    mode: 'whole',
    blockIds: [],
    focus: '',
    criteria: [
      {
        id: 'overall',
        title: '目标与约束',
        standard: '符合任务目标和约束；主张有依据，逻辑与计算正确。',
      },
    ],
  };
}

export function reviewSpecError(spec: ReviewSpec, task: Task) {
  if (!ReviewSpecSchema.safeParse(spec).success) return '请填写 1–6 个审查项的名称与验收标准。';
  if (new Set(spec.criteria.map((c) => c.id)).size !== spec.criteria.length)
    return '审查项标识不能重复。';
  if (new Set(spec.blockIds).size !== spec.blockIds.length) return '段落不能重复选择。';
  if (spec.mode === 'whole' && (spec.blockIds.length || spec.focus))
    return '整篇审查不能附带局部范围。';
  if (spec.mode === 'blocks' && (!spec.blockIds.length || spec.focus))
    return '请至少选择一个段落。';
  if (spec.mode === 'focus' && (!spec.focus.trim() || spec.blockIds.length))
    return '请填写这次要审查的具体问题或方向。';
  const blocks = task.revisions.find((r) => r.id === task.currentRevision)?.blocks || [];
  if (spec.blockIds.some((id) => !blocks.some((b) => b.id === id)))
    return '选中的段落已删除，请重新选择审查范围。';
  return '';
}

export const verdictNames: Record<Assessment['verdict'], string> = {
  passed: '通过',
  needs_revision: '需修改',
  insufficient: '证据不足',
};
export const scopeNames: Record<ReviewSpec['mode'], string> = {
  whole: '整篇方案',
  blocks: '选中段落',
  focus: '指定问题',
};
export function scopeKey(spec: ReviewSpec) {
  return JSON.stringify([spec.mode, [...spec.blockIds].sort(), spec.focus]);
}

export function reconcileReviewBlocks(spec: ReviewSpec, blocks: Block[]): ReviewSpec {
  const ids = spec.blockIds.filter((id) => blocks.some((b) => b.id === id));
  return ids.length === spec.blockIds.length ? spec : { ...spec, blockIds: ids };
}

export function prepareCriterionReview(current: ReviewSpec, target: ReviewSpec): ReviewSpec | null {
  const criterion = target.criteria[0];
  const exists = current.criteria.some((c) => c.id === criterion.id);
  if (!exists && current.criteria.length >= 6) return null;
  return {
    ...target,
    criteria: exists
      ? current.criteria.map((c) => (c.id === criterion.id ? criterion : c))
      : [...current.criteria, criterion],
  };
}

// A complete document is context, not permission to patch outside the target.
export function reviewBlockAllowed(spec: ReviewSpec, blockId: string) {
  return spec.mode !== 'blocks' || spec.blockIds.includes(blockId);
}

export function checkedAssessments(task: Task, spec: ReviewSpec, review: Review): Assessment[] {
  const revision = task.revisions.find((r) => r.id === task.currentRevision)!;
  return spec.criteria.map((criterion) => {
    const assessment = review.assessments!.find((a) => a.criterionId === criterion.id)!;
    const evidence: Assessment['evidence'] = [];
    for (const e of assessment.evidence) {
      if (!e.quote.trim()) continue;
      // Normalize model ID mistakes only after an exact quote match.
      if (
        e.blockId &&
        reviewBlockAllowed(spec, e.blockId) &&
        revision.blocks.find((b) => b.id === e.blockId)?.content.includes(e.quote)
      )
        evidence.push({ blockId: e.blockId, sourceId: '', quote: e.quote });
      else if (e.sourceId && task.sources.find((s) => s.id === e.sourceId)?.text.includes(e.quote))
        evidence.push({ blockId: '', sourceId: e.sourceId, quote: e.quote });
    }
    if (assessment.verdict === 'needs_revision' && !evidence.length) {
      for (const finding of review.findings.filter((f) => f.criterionId === criterion.id)) {
        const content = revision.blocks.find((b) => b.id === finding.blockId)?.content;
        if (
          reviewBlockAllowed(spec, finding.blockId) &&
          finding.before.trim() &&
          content?.split(finding.before).length === 2
        )
          evidence.push({ blockId: finding.blockId, sourceId: '', quote: finding.before });
      }
    }
    if (assessment.verdict !== 'insufficient' && !evidence.length)
      return {
        ...assessment,
        evidence,
        verdict: 'insufficient',
        reason: '未提供可定位的有效依据，不能确认原结论。模型原说明：' + assessment.reason,
      };
    return { ...assessment, evidence };
  });
}

export function assessmentStaleReason(task: Task, run: Run) {
  if (task.currentRevision !== run.baseRevision)
    return '正文或约束版本已变化；保留原结论，需确认改动是否影响本项。';
  if (
    !run.reviewBasis ||
    run.reviewBasis.goal !== task.goal ||
    JSON.stringify(run.reviewBasis.sources) !==
      JSON.stringify(task.sources.map(({ id, version }) => ({ id, version })))
  )
    return '目标或参考材料已变化，需按最新内容复核。';
  return '';
}

export function scopedOutputError(spec: ReviewSpec, review: Review) {
  const ids = review.assessments?.map((a) => a.criterionId) || [];
  if (
    ids.length !== spec.criteria.length ||
    new Set(ids).size !== ids.length ||
    spec.criteria.some((c) => !ids.includes(c.id))
  )
    return '模型未完整返回本次审查项，或混入了其他项目。';
  if (review.findings.some((f) => !reviewBlockAllowed(spec, f.blockId)))
    return '模型提出了审查范围之外的修改，本步骤结果未采用。';
  if (
    review.findings.some(
      (f) =>
        !spec.criteria.some((c) => c.id === f.criterionId) ||
        !review.assessments?.some(
          (a) => a.criterionId === f.criterionId && a.verdict === 'needs_revision',
        ),
    )
  )
    return '修改建议未绑定需修改的验收项，不能将通过或缺证项目直接改写。';
  return '';
}

export function supersedeScopedFindings(task: Task, run: Run) {
  if (!['succeeded', 'partial'].includes(run.state) || !run.reviewSpec || run.mode !== 'live')
    return;
  for (const finding of task.findings) {
    if (!finding.criterionId || !['pending', 'deferred'].includes(finding.status)) continue;
    const oldRun = task.runs.find((r) => r.id === finding.runId);
    const oldCriterion = oldRun?.reviewSpec?.criteria.find((c) => c.id === finding.criterionId);
    if (
      oldRun?.mode !== run.mode ||
      !oldRun.reviewSpec ||
      scopeKey(oldRun.reviewSpec) !== scopeKey(run.reviewSpec)
    )
      continue;
    if (!run.reviewSpec.criteria.some((c) => JSON.stringify(c) === JSON.stringify(oldCriterion)))
      continue;
    if (!run.assessments?.some((a) => a.criterionId === finding.criterionId)) continue;
    finding.stale = true;
    finding.supersededBy = run.id;
  }
}

export function assessmentRows(task: Task) {
  const rows = new Map<
    string,
    {
      run: Run;
      criterion: ReviewSpec['criteria'][number];
      assessment: Assessment;
      staleReason: string;
    }
  >();
  // Runs are appended in creation order. Visit newest first so replacing an
  // existing scope/criterion cannot retain the Map's older insertion order.
  for (const run of task.runs.slice().reverse()) {
    if (!['succeeded', 'partial'].includes(run.state) || !run.reviewSpec) continue;
    for (const assessment of run.assessments || []) {
      const criterion = run.reviewSpec.criteria.find((c) => c.id === assessment.criterionId);
      if (!criterion) continue;
      const key = JSON.stringify([run.mode, scopeKey(run.reviewSpec), criterion]);
      if (!rows.has(key))
        rows.set(key, {
          run,
          criterion,
          assessment,
          staleReason: assessmentStaleReason(task, run),
        });
    }
  }
  return [...rows.values()];
}

export function assessmentGroups(task: Task, mode: 'demo' | 'live', spec: ReviewSpec) {
  const rows = assessmentRows(task).filter((r) => r.run.mode === mode);
  const matching = rows.filter(
    (r) =>
      scopeKey(r.run.reviewSpec!) === scopeKey(spec) &&
      spec.criteria.some((c) => JSON.stringify(c) === JSON.stringify(r.criterion)),
  );
  const primary = matching.length ? matching : rows.filter((r) => r.run.id === rows[0]?.run.id);
  return {
    primary,
    history: rows.filter((r) => !primary.includes(r)),
    current: matching.length > 0,
  };
}
