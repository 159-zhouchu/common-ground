import { RotateCcw } from 'lucide-react';
import type { Task } from '@/lib/types';
import { date } from './format';
type Props = {
  task: Task;
  revision: Task['revisions'][number];
  versionId: string;
  setVersionId: (id: string) => void;
  busy: boolean;
  dirty: boolean;
  onRestore: (id: string) => void;
  onActivity: () => void;
};
export function VersionsDrawer({
  task,
  revision,
  versionId,
  setVersionId,
  busy,
  dirty,
  onRestore,
  onActivity,
}: Props) {
  return (
    task &&
    revision && (
      <>
        <p>恢复旧版会创建新版本，已有历史保留。</p>
        <div className="cg-version-list" role="radiogroup" aria-label="选择预览版本">
          {task.revisions
            .slice()
            .reverse()
            .map((r) => (
              <button
                key={r.id}
                role="radio"
                aria-checked={(versionId || revision.id) === r.id}
                tabIndex={(versionId || revision.id) === r.id ? 0 : -1}
                onClick={() => setVersionId(r.id)}
                onKeyDown={(event) => {
                  const buttons = Array.from(
                    event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                      '[role="radio"]',
                    ),
                  );
                  const index = buttons.indexOf(event.currentTarget);
                  const target =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? buttons.length - 1
                        : ['ArrowRight', 'ArrowDown'].includes(event.key)
                          ? (index + 1) % buttons.length
                          : ['ArrowLeft', 'ArrowUp'].includes(event.key)
                            ? (index + buttons.length - 1) % buttons.length
                            : -1;
                  if (target < 0) return;
                  event.preventDefault();
                  buttons[target].focus();
                  buttons[target].click();
                }}
              >
                <b>
                  v{r.number}
                  {r.id === revision.id ? ' · 当前' : ''}
                </b>
                <span>{r.reason}</span>
                <small>{date(r.createdAt)}</small>
              </button>
            ))}
        </div>
        {(() => {
          const r = task.revisions.find((r) => r.id === (versionId || revision.id)) || revision;
          return (
            <section className="cg-version-preview">
              <h3>
                v{r.number} · {r.reason}
              </h3>
              {r.id !== revision.id && (
                <button
                  className="cg-secondary"
                  disabled={busy || !!dirty}
                  onClick={() => onRestore(r.id)}
                >
                  <RotateCcw size={15} />
                  恢复为新版本
                </button>
              )}
              <p>约束：{r.constraint || '未设置'}</p>
              {r.blocks.map((b) => (
                <section
                  key={b.id}
                  className={
                    revision.blocks.find((x) => x.id === b.id)?.content !== b.content
                      ? 'cg-version-changed'
                      : undefined
                  }
                >
                  <h4>
                    {b.title}
                    {revision.blocks.find((x) => x.id === b.id)?.content !== b.content && (
                      <small> · 与当前版本不同</small>
                    )}
                  </h4>
                  <p>{b.content}</p>
                </section>
              ))}
            </section>
          );
        })()}
        <h3>原材料新分支</h3>
        {task.runs
          .filter((r) => r.contextMode === 'source_only')
          .map((r) => (
            <button className="cg-text-button" key={r.id} onClick={() => onActivity()}>
              {date(r.createdAt)} · {r.summary || '尚无结果'}
            </button>
          ))}
        {!task.runs.some((r) => r.contextMode === 'source_only') && (
          <p className="cg-muted">尚无新分支。可在检查方式的输入详情中选择。</p>
        )}
      </>
    )
  );
}
