import type { Task, Revision, Block, Manifest, RunOptions, Step } from './types';
import {
  MAX_MODEL_INPUT_BYTES,
  MAX_DOCUMENT_MULTISTEP_BYTES,
  PRIOR_OUTPUT_RESERVE_BYTES,
} from './limits';

// Shared by the browser preview and server requests; keep Node-only APIs out.
const duties: Record<string, string> = {
  answer: '检查当前任务并回答；只在有具体理由时提出局部修订。',
  self_check:
    '复核上一份回答，按约束、原文、计算和未决异议检查；返回完整的修订后结果，可撤回错误质疑。',
  independent: '独立形成候选方案或评审意见。不能假设存在其他候选。',
  compare:
    '独立阶段已结束，现在显式比较此前候选与当前方案，指出互补和分歧；有原文依据的修订才进入 findings，不以投票裁决。',
  evidence:
    '围绕当前方案的具体主张核对材料，先找原文，再判断支持、矛盾或缺证。计算请给出可人工核对的算式。',
  evidence_review:
    '复核上一份证据评审是否准确引用、是否误改正确内容、是否遗漏关键约束；返回完整最终建议，并撤回无效质疑。',
};
export function reviewInput(input: Manifest, duty: string) {
  return { duty: duties[duty] || duties.answer, input };
}
export function manifestContent(
  task: Task,
  revision: Revision,
  mode: Manifest['mode'],
  draft?: Block[],
): Omit<Manifest, 'hash'> {
  return {
    goal: task.goal,
    constraint: revision.constraint,
    sources: task.sources.map((s) => ({ id: s.id, version: s.version, text: s.text })),
    blocks: mode === 'continue' ? (draft ?? revision.blocks) : [],
    messages: mode === 'continue' ? task.messages.slice(-10) : [],
    mode,
    excluded:
      mode === 'source_only'
        ? ['当前成果（含用户稿与 AI 稿）', '历史 AI 回答与讨论', 'AI 摘要、问题和派生约束']
        : [],
  };
}
export function documentSteps(opts: RunOptions): Pick<Step, 'label' | 'slot' | 'duty'>[] {
  const make = (label: string, slot: Step['slot'], duty: string) => ({ label, slot, duty });
  if (opts.mode === 'demo') return [make('读取合成示例与演示检查结果', 'demo', 'demo')];
  if (opts.strategy === 'S1')
    return [
      make('模型 A · 独立提案', 'a', 'independent'),
      make('模型 B · 独立提案', 'b', 'independent'),
      make('最终比较与修改建议', opts.compareRole || 'a', 'compare'),
    ];
  if (opts.strategy === 'S5')
    return [
      make('提取主张，核对材料依据', 'a', 'evidence'),
      make('复核引用与修订范围', 'b', 'evidence_review'),
    ];
  return [
    make('生成回答与候选修改', opts.roleAssignments ? 'a' : opts.slot, 'answer'),
    ...(opts.selfCheck
      ? [make('按约束与原文进行自检', opts.roleAssignments ? 'a' : opts.slot, 'self_check')]
      : []),
  ];
}
export function documentInputBudget(task: Task, opts: RunOptions) {
  const revision = task.revisions.find((r) => r.id === task.currentRevision);
  if (!revision) throw new Error('成果版本不存在');
  const steps = documentSteps(opts),
    limit = steps.length > 1 ? MAX_DOCUMENT_MULTISTEP_BYTES : MAX_MODEL_INPUT_BYTES;
  const sizes = steps.map((step) => {
    const mode = step.duty === 'compare' ? 'continue' : opts.contextMode;
    // Every SHA-256 hex digest is 64 ASCII bytes; its value cannot affect size.
    const input = { ...manifestContent(task, revision, mode), hash: '0'.repeat(64) };
    const bytes = new TextEncoder().encode(
      JSON.stringify(reviewInput(input, step.duty)),
    ).byteLength;
    const predecessors =
      step.duty === 'compare' ? 2 : ['self_check', 'evidence_review'].includes(step.duty) ? 1 : 0;
    return { ...step, mode, bytes, reserve: predecessors * PRIOR_OUTPUT_RESERVE_BYTES };
  });
  return {
    steps: sizes,
    limit,
    bytes: Math.max(...sizes.map((s) => s.bytes)),
    reserve: Math.max(...sizes.map((s) => s.reserve)),
    exceeded: sizes.some((s) => s.bytes > limit || s.bytes + s.reserve > MAX_MODEL_INPUT_BYTES),
  };
}
