import { createHash, randomUUID } from 'node:crypto';
import type { Task, Block, Manifest, RunOptions, Step, Finding, Review, Impact } from './types';
import { now } from './seed';
import { MAX_BLOCK_CHARACTERS, MAX_DOCUMENT_CHARACTERS } from './limits';
import { manifestContent, documentSteps } from './document-input';
import { findingStateNames, exportDate } from './text';
export const uid = () => randomUUID();
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function current(task: Task) {
  const r = task.revisions.find((r) => r.id === task.currentRevision);
  if (!r) throw new AppError('NOT_FOUND', '成果版本不存在', 404);
  return r;
}
export function requireIdle(task: Task) {
  if (task.runs.some((r) => r.state === 'running'))
    throw new AppError('RUN_ACTIVE', '当前任务正在运行，请先停止运行。', 409);
}
export function plan(opts: RunOptions): Step[] {
  return documentSteps(opts).map((step) => ({ ...step, id: uid(), status: 'queued', cost: null }));
}
export function manifest(task: Task, mode: 'continue' | 'source_only', draft?: Block[]): Manifest {
  const raw = manifestContent(task, current(task), mode, draft);
  return { ...raw, hash: createHash('sha256').update(JSON.stringify(raw)).digest('hex') };
}
export function appendRevision(
  task: Task,
  blocks: Block[],
  constraint: string,
  reason: string,
  base: string,
) {
  if (task.currentRevision !== base)
    throw new AppError(
      'REVISION_CONFLICT',
      '成果已经改变，请刷新后检查最新版本。你的草稿仍然保留。',
      409,
    );
  const prev = current(task);
  const rev = {
    ...prev,
    id: uid(),
    number: task.revisions.length + 1,
    blocks: structuredClone(blocks),
    constraint,
    reason,
    createdAt: now(),
    parentId: prev.id,
  };
  task.revisions.push(rev);
  task.currentRevision = rev.id;
  task.updatedAt = now();
  for (const f of task.findings) {
    if (f.status === 'pending' || f.status === 'deferred') {
      const b = blocks.find((b) => b.id === f.blockId);
      const old = prev.blocks.find((b) => b.id === f.blockId);
      const source = task.sources.find((s) => s.id === f.sourceId);
      f.stale =
        f.stale ||
        !b ||
        !old ||
        b.content !== old.content ||
        b.title !== old.title ||
        constraint !== prev.constraint ||
        (!!f.sourceId && (!source || source.version !== f.sourceVersion));
      if (!f.stale) f.baseRevision = rev.id;
    }
  }
  return rev;
}
export function applyFinding(task: Task, id: string, base: string) {
  const f = task.findings.find((f) => f.id === id);
  if (!f) throw new AppError('NOT_FOUND', '修改建议不存在', 404);
  if (f.status === 'accepted' || f.status === 'rejected')
    throw new AppError('PATCH_RESOLVED', '这条建议已经处理。', 409);
  const r = current(task);
  if (f.stale || f.baseRevision !== base || base !== r.id)
    throw new AppError('REVISION_CONFLICT', '建议已过时，请基于当前版本重新核查。', 409);
  const b = r.blocks.find((b) => b.id === f.blockId);
  if (
    !f.before ||
    typeof f.after !== 'string' ||
    !b ||
    !b.content.includes(f.before) ||
    b.content.split(f.before).length !== 2
  )
    throw new AppError('PATCH_SCOPE', '无法唯一定位原文，不能自动应用这条修改。', 409);
  if (f.sourceId) {
    const s = task.sources.find((s) => s.id === f.sourceId);
    if (!s || s.version !== f.sourceVersion)
      throw new AppError('SOURCE_STALE', '材料已更新，请重新核查。', 409);
  }
  const blocks = r.blocks.map((block) =>
    block.id === f.blockId
      ? { ...block, origin: 'ai' as const, content: block.content.replace(f.before, () => f.after) }
      : block,
  );
  if (
    blocks.some((b) => b.content.length > MAX_BLOCK_CHARACTERS) ||
    blocks.reduce((n, b) => n + b.content.length, 0) > MAX_DOCUMENT_CHARACTERS
  )
    throw new AppError(
      'PATCH_LIMIT',
      '采纳后将超过单段 50,000 或全文 150,000 字符上限，请先缩短正文。',
      409,
    );
  const rev = appendRevision(task, blocks, r.constraint, '采用修改：' + f.title, base);
  f.status = 'accepted';
  f.stale = false;
  f.appliedRevision = rev.id;
  task.impacts = impactFor(task, r.constraint, r.constraint, [f.blockId]);
  return rev;
}
export function normalizeReview(
  task: Task,
  review: Review,
  runId: string,
  baseRevision: string,
): Finding[] {
  return review.findings.slice(0, 12).map((f) => {
    const s = task.sources.find((s) => s.id === f.sourceId);
    const b = current(task).blocks.find((b) => b.id === f.blockId);
    return {
      ...f,
      id: uid(),
      sourceVersion: s?.version,
      quoteValid: !!s && !!f.quote && s.text.includes(f.quote),
      status: 'pending',
      baseRevision,
      stale: current(task).id !== baseRevision || !b || !f.before || !b.content.includes(f.before),
      runId,
    };
  });
}
export function impactFor(
  task: Task,
  oldConstraint: string,
  newConstraint: string,
  changedBlocks: string[] = [],
): Impact[] {
  const r = current(task);
  const changedConstraint = oldConstraint !== newConstraint;
  return r.blocks.map((b) => {
    let state: Impact['state'] = 'unchecked',
      reason = '语义关联尚未自动分析；本次没有据此判定为无影响。',
      rule = '未执行语义分析';
    if (changedBlocks.includes(b.id)) {
      state = 'review';
      reason = '该段刚被手动修改，已有引用和相关结论需要重新检查。';
      rule = '段落变更';
    } else if (
      changedConstraint &&
      /预算|元|费用/.test(newConstraint + oldConstraint) &&
      /预算|税费|总额|配送|成本/.test(b.content)
    ) {
      state = 'review';
      reason = '约束含预算变化，段落包含费用或预算主张；请核对合计与新上限。';
      rule = '显式预算词匹配（有限覆盖）';
    } else if (
      changedConstraint &&
      /时间|周期|日期|天|周|月/.test(newConstraint + oldConstraint) &&
      /月|日|天|周|交付|时间/.test(b.content)
    ) {
      state = 'possible';
      reason = '时间相关条件发生变化，此段包含时间安排，可能需要联动修改。';
      rule = '时间词候选（待人审）';
    }
    return { id: uid(), blockId: b.id, title: b.title, state, reason, rule, createdAt: now() };
  });
}
export function markdown(task: Task, review = false) {
  const r = current(task);
  return (
    '# ' +
    task.title +
    '\n\n> 版本 v' +
    r.number +
    ' · ' +
    exportDate(r.createdAt) +
    (task.example ? ' · 合成示例' : '') +
    '\n\n## 任务约束\n\n' +
    r.constraint +
    '\n\n' +
    r.blocks.map((b) => '## ' + (b.title || '段落') + '\n\n' + b.content).join('\n\n') +
    (review
      ? '\n\n---\n\n## 问题与依据记录\n\n处理状态截至导出时，正文绑定上述版本。\n\n' +
        task.findings
          .map(
            (f) =>
              '### ' +
              f.title +
              '\n\n状态：' +
              findingStateNames[f.status] +
              (f.stale ? '（需重审）' : '') +
              '\n\n' +
              f.reason +
              '\n\n原文：' +
              (f.quote || '未提供') +
              '\n\n材料：' +
              (task.sources.find((s) => s.id === f.sourceId)?.name || '无定位') +
              ' v' +
              (f.sourceVersion ?? '?') +
              '\n\n采用建议不等于事实已经验证。',
          )
          .join('\n\n')
      : '')
  );
}
