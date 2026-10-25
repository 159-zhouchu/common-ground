'use client';
import {
  Plus,
  Trash2,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  CircleHelp,
  ChevronDown,
} from 'lucide-react';
import type { ReviewSpec, Task } from '@/lib/types';
import { assessmentGroups, reviewSpecError, scopeNames, verdictNames } from '@/lib/review-scope';

export function ReviewControls({
  task,
  spec,
  selectedIds,
  disabled,
  enabled,
  onChange,
  onSelect,
}: {
  task: Task;
  spec: ReviewSpec;
  selectedIds: string[];
  disabled: boolean;
  enabled: boolean;
  onChange: (spec: ReviewSpec) => void;
  onSelect: (ids: string[]) => void;
}) {
  const blocks = task.revisions.find((r) => r.id === task.currentRevision)?.blocks ?? [];
  const effective = { ...spec, criteria: spec.criteria.filter((c) => selectedIds.includes(c.id)) };
  const error = reviewSpecError(effective, task);
  return (
    <details className="cg-review-controls" id="review-controls" aria-label="审查范围与验收">
      <summary>
        <span>
          <b>审查范围与验收</b>
          <span>
            {enabled ? `${scopeNames[spec.mode]} · ${effective.criteria.length} 项` : '原材料重答'}
          </span>
          {enabled && error && (
            <span className="cg-review-error-collapsed" role="status">
              {error}
            </span>
          )}
        </span>
        <ChevronDown size={16} />
      </summary>
      <fieldset disabled={disabled || !enabled}>
        <div className="cg-review-modes" role="group" aria-label="审查范围">
          {(['whole', 'blocks', 'focus'] as const).map((mode) => (
            <label key={mode} className={spec.mode === mode ? 'chosen' : ''}>
              <input
                type="radio"
                name="review-scope"
                checked={spec.mode === mode}
                onChange={() => onChange({ ...spec, mode, blockIds: [], focus: '' })}
              />
              {scopeNames[mode]}
            </label>
          ))}
        </div>
        {spec.mode === 'blocks' && (
          <div className="cg-review-blocks" role="group" aria-label="选择审查段落">
            {blocks.map((b, i) => (
              <label key={b.id}>
                <input
                  type="checkbox"
                  checked={spec.blockIds.includes(b.id)}
                  onChange={(e) =>
                    onChange({
                      ...spec,
                      blockIds: e.target.checked
                        ? [...spec.blockIds, b.id]
                        : spec.blockIds.filter((id) => id !== b.id),
                    })
                  }
                />
                {b.title || `第 ${i + 1} 段`}
              </label>
            ))}
          </div>
        )}
        {spec.mode === 'focus' && (
          <label className="cg-review-focus">
            审查问题或方向
            <textarea
              aria-label="审查问题或方向"
              rows={2}
              maxLength={1200}
              value={spec.focus}
              placeholder="例如：只核对预算合计与费用遗漏"
              onChange={(e) => onChange({ ...spec, focus: e.target.value })}
            />
          </label>
        )}
        <div className="cg-review-criteria-heading">
          <h2>
            验收项 <small>{spec.criteria.length} / 6</small>
          </h2>
          <button
            type="button"
            className="cg-text-button"
            disabled={disabled || !enabled || spec.criteria.length >= 6}
            onClick={() => {
              const id = crypto.randomUUID();
              onChange({ ...spec, criteria: [...spec.criteria, { id, title: '', standard: '' }] });
              onSelect([...selectedIds, id]);
            }}
          >
            <Plus size={15} />
            添加审查项
          </button>
        </div>
        <div className="cg-review-criteria">
          {spec.criteria.map((c, i) => (
            <div className="cg-review-criterion" key={c.id}>
              <label className="cg-review-select">
                <input
                  aria-label={'本次检查第 ' + (i + 1) + ' 项'}
                  type="checkbox"
                  checked={selectedIds.includes(c.id)}
                  onChange={(e) =>
                    onSelect(
                      e.target.checked
                        ? [...selectedIds, c.id]
                        : selectedIds.filter((id) => id !== c.id),
                    )
                  }
                />
                本次
              </label>
              <label>
                审查项 {i + 1}
                <input
                  aria-label={'审查项 ' + (i + 1)}
                  maxLength={120}
                  value={c.title}
                  placeholder="例如：预算计算"
                  onChange={(e) =>
                    onChange({
                      ...spec,
                      criteria: spec.criteria.map((x) =>
                        x.id === c.id ? { ...x, title: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <label>
                验收标准
                <textarea
                  aria-label={'验收标准 ' + (i + 1)}
                  rows={2}
                  maxLength={1200}
                  value={c.standard}
                  placeholder="例如：分项相加等于总额，费用均有材料依据"
                  onChange={(e) =>
                    onChange({
                      ...spec,
                      criteria: spec.criteria.map((x) =>
                        x.id === c.id ? { ...x, standard: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <button
                type="button"
                className="cg-icon"
                title={'删除审查项 ' + (i + 1)}
                aria-label={'删除审查项 ' + (i + 1)}
                disabled={disabled || !enabled || spec.criteria.length === 1}
                onClick={() => {
                  onChange({ ...spec, criteria: spec.criteria.filter((x) => x.id !== c.id) });
                  onSelect(selectedIds.filter((id) => id !== c.id));
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      </fieldset>
      {!enabled ? (
        <p className="cg-review-note">原材料重答不读取当前方案，不生成分项验收结论。</p>
      ) : error ? (
        <p className="cg-review-error" role="status">
          {error}
        </p>
      ) : null}
    </details>
  );
}

export function AssessmentPanel({
  task,
  mode,
  spec,
  disabled,
  onPrepare,
  onEvidence,
}: {
  task: Task;
  mode: 'live' | 'demo';
  spec: ReviewSpec;
  disabled: boolean;
  onPrepare: (spec: ReviewSpec) => void;
  onEvidence: (blockId: string, sourceId: string) => void;
}) {
  const { primary, history, current } = assessmentGroups(task, mode, spec);
  if (!primary.length) return null;
  const renderRows = (rows: typeof primary) =>
    rows.map(({ run, criterion, assessment, staleReason }) => (
      <article className="cg-assessment" key={run.id + criterion.id}>
        <div className="cg-assessment-heading">
          <h4>{criterion.title}</h4>
          <span className={'cg-verdict ' + (staleReason ? 'stale' : assessment.verdict)}>
            {staleReason || assessment.verdict === 'insufficient' ? (
              <CircleHelp size={14} />
            ) : assessment.verdict === 'passed' ? (
              <CheckCircle2 size={14} />
            ) : (
              <AlertCircle size={14} />
            )}
            {staleReason
              ? '待复核 · 此前' + verdictNames[assessment.verdict]
              : verdictNames[assessment.verdict]}
          </span>
        </div>
        <small>
          {scopeNames[run.reviewSpec!.mode]} · v
          {task.revisions.find((r) => r.id === run.baseRevision)?.number ?? '?'}
          {run.mode === 'demo' ? ' · 合成示例' : ''}
          {run.state === 'partial' ? ' · 部分完成' : ''}
        </small>
        {run.reviewSpec!.focus && <p className="cg-assessment-focus">{run.reviewSpec!.focus}</p>}
        {run.reviewSpec!.mode === 'blocks' && (
          <p className="cg-assessment-focus">
            {run
              .reviewSpec!.blockIds.map(
                (id) =>
                  task.revisions
                    .find((r) => r.id === run.baseRevision)
                    ?.blocks.find((b) => b.id === id)?.title ||
                  task.revisions
                    .find((r) => r.id === task.currentRevision)
                    ?.blocks.find((b) => b.id === id)?.title ||
                  '原段落已删除',
              )
              .join('、')}
          </p>
        )}
        <details>
          <summary>验收标准</summary>
          <p>{criterion.standard}</p>
        </details>
        {run.mode !== 'demo' && <p>{assessment.reason}</p>}
        {staleReason && <p className="cg-review-error">{staleReason}</p>}
        {assessment.evidence.map((e, i) => (
          <blockquote key={i}>
            <p>{e.quote}</p>
            <button
              type="button"
              className="cg-text-button"
              disabled={
                e.sourceId
                  ? !task.sources.some((s) => s.id === e.sourceId)
                  : !task.revisions
                      .find((r) => r.id === task.currentRevision)
                      ?.blocks.some((b) => b.id === e.blockId)
              }
              onClick={() => onEvidence(e.blockId, e.sourceId)}
            >
              {e.sourceId ? '查看材料' : '定位段落'}
            </button>
          </blockquote>
        ))}
        <button
          type="button"
          className="cg-text-button"
          disabled={disabled}
          onClick={() => onPrepare({ ...run.reviewSpec!, criteria: [criterion] })}
        >
          <RotateCcw size={14} />
          准备复查此项
        </button>
      </article>
    ));
  return (
    <section className="cg-assessments" aria-label="分项审查结论">
      <header>
        <h3>{current ? '当前分项结论' : '最近一轮分项结论'}</h3>
        <span>
          通过 {primary.filter((r) => r.assessment.verdict === 'passed' && !r.staleReason).length} ·{' '}
          需修改{' '}
          {
            primary.filter((r) => r.assessment.verdict === 'needs_revision' && !r.staleReason)
              .length
          }{' '}
          · 证据不足{' '}
          {primary.filter((r) => r.assessment.verdict === 'insufficient' && !r.staleReason).length}{' '}
          · 待复核 {primary.filter((r) => !!r.staleReason).length}
        </span>
      </header>
      {mode === 'demo' && <p className="cg-review-note">合成示例不评估自定义验收标准。</p>}
      {renderRows(primary)}
      {!!history.length && (
        <details className="cg-assessment-history">
          <summary>其他范围与历史结论（{history.length} 项）</summary>
          {renderRows(history)}
        </details>
      )}
    </section>
  );
}
