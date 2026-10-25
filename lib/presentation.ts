import type { Finding, Task, Run, StrategyId } from './types';

export type PublicConnection = {
  enabled?: boolean;
  label: string;
  model: string;
  configured: boolean;
  inputPrice: number | null;
  outputPrice: number | null;
};
export const checkMethods = [
  { id: 'S0', name: '快速检查', description: '检查明显问题，可再让同一模型自检一次。' },
  { id: 'S1', name: '多角度分析', description: '两个模型分别分析，再比较意见和分歧。' },
  { id: 'S5', name: '核对材料', description: '对照材料查主张，再由另一模型复核。' },
] as const;
export function effectiveMode(task: Pick<Task, 'example'>, mode: 'demo' | 'live') {
  return task.example ? mode : 'live';
}
export function callCount(strategy: StrategyId, selfCheck: boolean) {
  return strategy === 'S1' ? 3 : strategy === 'S5' ? 2 : selfCheck ? 2 : 1;
}
export const formatMoney = (n: number | null) => (n === null ? '费用待核对' : '$' + n.toFixed(6));
export const MAX_DRAFT_CHARACTERS = 50000;
export function draftImportError(bytes: number, text: string) {
  return bytes > 300000
    ? '原稿文件不超过 300 KB。'
    : text.length > MAX_DRAFT_CHARACTERS
      ? '方案正文不超过 50,000 字符，请缩短后导入。'
      : '';
}
export function recommendation(task: Pick<Task, 'sources'>, connections: PublicConnection[]) {
  return task.sources.length &&
    connections.filter((c) => c.configured && c.enabled !== false).length >= 2
    ? { strategy: 'S5' as const, reason: '已有参考材料和两个连接，适合逐项核对依据。' }
    : {
        strategy: 'S0' as const,
        reason: task.sources.length
          ? '先用一个模型检查；双模型核查需要两个连接。'
          : '尚无参考材料，可先检查方案本身的明显漏洞。',
      };
}
export function staleReason(task: Task, f: Finding) {
  if (f.supersededBy) return '该项已完成新一轮审查，此建议保留为历史记录；请查看最新分项结论。';
  const revision = task.revisions.find((r) => r.id === task.currentRevision);
  const old = task.revisions.find((r) => r.id === f.baseRevision);
  const source = task.sources.find((s) => s.id === f.sourceId);
  if (f.status === 'accepted') return '';
  if (f.sourceId && (!source || source.version !== f.sourceVersion))
    return source
      ? `引用材料已从 v${f.sourceVersion ?? '?'} 更新为 v${source.version}，请重新核查。`
      : '引用材料已不存在，无法按原依据采纳。';
  if (old && revision && old.constraint !== revision.constraint)
    return '任务约束已改变，旧建议需要按新约束重新检查。';
  const block = revision?.blocks.find((b) => b.id === f.blockId);
  if (!block) return '目标段落已改变或不存在，无法定位要修改的位置。';
  if (!f.before || typeof f.after !== 'string')
    return '这条意见没有可直接应用的局部修改，请先补充或人工核对。';
  if (block.content.split(f.before).length !== 2)
    return '正文中的目标片段已修改，或出现多次，无法唯一定位。';
  if (f.stale || f.baseRevision !== task.currentRevision)
    return '检查后成果版本已更新；请基于当前方案重新检查。';
  return '';
}
export function filteredFindings(
  findings: Finding[],
  filter: 'pending' | 'all' | 'resolved' | 'stale',
) {
  return findings
    .filter(
      (f) =>
        filter === 'all' ||
        (filter === 'pending' && !f.stale && (f.status === 'pending' || f.status === 'deferred')) ||
        (filter === 'stale' &&
          f.stale &&
          !f.supersededBy &&
          (f.status === 'pending' || f.status === 'deferred')) ||
        (filter === 'resolved' && (f.status === 'accepted' || f.status === 'rejected')),
    )
    .slice()
    .sort(
      (a, b) =>
        ({ high: 0, medium: 1, low: 2 })[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity],
    );
}
export function runFeedback(run: Run, findings: Finding[]) {
  const discovered = findings.filter((f) => f.runId === run.id).length;
  if (run.state === 'running')
    return {
      tone: 'running',
      title: '正在检查',
      detail: run.steps.find((s) => s.status === 'running')?.label || '等待下一阶段开始。',
    };
  if (run.state === 'failed')
    return {
      tone: 'error',
      title: '检查失败',
      detail:
        run.error ||
        run.steps.find((s) => s.error)?.error ||
        '没有取得可用结果，请查看调用记录并调整配置。',
    };
  if (run.state === 'partial') {
    const step = run.steps.find((s) => s.status === 'failed' && s.error);
    return {
      tone: 'warning',
      title: '部分完成',
      detail: `已有结果保留；${step ? step.label + '：' + step.error : run.error || '部分步骤失败。'}结论可能不完整，请查看调用记录。`,
    };
  }
  if (run.state === 'cancelled')
    return {
      tone: 'neutral',
      title: '检查已停止',
      detail: '已完成步骤保留在调用记录中；已发送请求仍可能计费。',
    };
  if (run.state === 'interrupted')
    return {
      tone: 'warning',
      title: '检查已中断',
      detail: '服务曾重启。请查看已完成步骤，再决定是否重新检查。',
    };
  if (run.reviewSpec && run.assessments)
    return {
      tone: 'neutral',
      title: '本次分项审查完成',
      detail: `${run.assessments.filter((a) => a.verdict === 'passed').length} 项通过，${run.assessments.filter((a) => a.verdict === 'needs_revision').length} 项需修改，${run.assessments.filter((a) => a.verdict === 'insufficient').length} 项证据不足；结论仅针对本次标准与版本。${run.mode === 'demo' ? '合成示例不判断自定义验收标准。' : ''}`,
    };
  return discovered
    ? {
        tone: 'success',
        title: `检查完成，新增 ${discovered} 条建议`,
        detail: '逐条核对并决定是否接受，正文不会自动修改。',
      }
    : {
        tone: 'neutral',
        title: '本次没有发现新问题',
        detail: `本轮新增 0 条；历史仍有 ${findings.filter((f) => !f.stale && (f.status === 'pending' || f.status === 'deferred')).length} 条待处理（含暂缓）。可能已有相同建议，或未发现可应用修改；不代表全文正确。`,
      };
}
