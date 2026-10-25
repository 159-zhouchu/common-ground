'use client';
import { BookOpen, ChevronDown, Link2 } from 'lucide-react';
import type { Finding } from '@/lib/types';
import { firstSentence, findingStateNames } from '@/lib/text';
import { Diff } from './shared';

export function FindingCard({
  finding,
  open,
  reason,
  onToggle,
  onShowBlock,
  onViewSource,
}: {
  finding: Finding;
  open: boolean;
  reason: string;
  onToggle: () => void;
  onShowBlock: () => void;
  onViewSource: () => void;
}) {
  const status = finding.supersededBy
    ? '已由新审查替代'
    : finding.stale
      ? '已过期 · 需重查'
      : finding.status !== 'pending'
        ? findingStateNames[finding.status]
        : '';
  return (
    <section className={'cg-finding ' + (open ? 'open' : '')} id={'card-' + finding.id}>
      <h3>
        <button
          className="cg-finding-summary"
          aria-expanded={open}
          aria-controls={'finding-' + finding.id}
          aria-labelledby={'title-' + finding.id}
          aria-describedby={'severity-' + finding.id + ' reason-' + finding.id}
          onClick={onToggle}
        >
          <span id={'severity-' + finding.id} className={'cg-priority ' + finding.severity}>
            {finding.severity === 'high'
              ? '优先处理'
              : finding.severity === 'medium'
                ? '建议检查'
                : '可选改进'}
          </span>
          <span className="cg-finding-title" id={'title-' + finding.id}>
            {finding.title}
          </span>
          <span id={'reason-' + finding.id} className="cg-finding-reason">
            {firstSentence(finding.reason)}
          </span>
          {status && <small>{status}</small>}
          <ChevronDown size={16} />
        </button>
      </h3>
      {open && (
        <div className="cg-finding-body" id={'finding-' + finding.id}>
          <button className="cg-text-button" onClick={onShowBlock}>
            在方案中查看
          </button>
          {finding.status !== 'accepted' && reason && (
            <div className="cg-alert warning">{reason}</div>
          )}
          <Diff before={finding.before} after={finding.after} />
          <h4>为什么修改</h4>
          <p>{finding.reason}</p>
          <details className="cg-evidence">
            <summary>
              <span>
                <BookOpen size={14} />
                材料依据
              </span>
              <small>
                {
                  { supports: '材料支持', contradicts: '材料矛盾', insufficient: '依据不足' }[
                    finding.relation
                  ]
                }
              </small>
              <ChevronDown size={14} />
            </summary>
            {finding.quote ? (
              <blockquote>{finding.quote}</blockquote>
            ) : (
              <p>未提供原始引用，需要人工核对。</p>
            )}
            <p className="cg-citation-status">
              <Link2 size={13} />
              {finding.quoteValid ? '引用可定位' : '引用尚未定位'}
              {finding.sourceId && <button onClick={onViewSource}>查看原文</button>}
            </p>
            <small>引用可定位仅指找到原句，不表示事实已经验证；支持关系仍需核对。</small>
          </details>
        </div>
      )}
    </section>
  );
}
