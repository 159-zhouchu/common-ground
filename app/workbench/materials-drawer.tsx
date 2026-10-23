import { ArrowLeft, Upload, Plus, FileText, ExternalLink } from 'lucide-react';
import type { Task, Finding } from '@/lib/types';
import { SourceText } from './shared';
type Props = {
  task: Task;
  busy: boolean;
  source?: Task['sources'][number];
  finding?: Finding;
  setSourceId: (id: string | null) => void;
  setReplaceId: (id: string) => void;
  onUpload: () => void;
};
export function MaterialsDrawer({
  task,
  busy,
  source,
  finding,
  setSourceId,
  setReplaceId,
  onUpload,
}: Props) {
  return (
    task && (
      <>
        {source ? (
          <>
            <button className="cg-text-button" onClick={() => setSourceId(null)}>
              <ArrowLeft size={15} />
              返回材料列表
            </button>
            <h3>{source.name}</h3>
            <p className="cg-muted">
              当前材料 v{source.version} · {source.text.length} 字符
            </p>
            {source.warning && <div className="cg-alert warning">{source.warning}</div>}
            {finding &&
              finding.sourceId === source.id &&
              finding.sourceVersion !== source.version && (
                <div className="cg-alert warning">
                  建议引用的是 v{finding.sourceVersion}，下方展示保留的旧版内容；当前材料已更新。
                </div>
              )}
            <SourceText
              text={
                finding?.sourceId === source.id && finding.sourceVersion !== source.version
                  ? (source.history?.find((h) => h.version === finding.sourceVersion)?.text ??
                    '该历史版本原文不可用。')
                  : source.text
              }
              quote={finding?.sourceId === source.id ? finding.quote : undefined}
            />
            <button
              className="cg-secondary"
              onClick={() => {
                setReplaceId(source.id);
                onUpload();
              }}
            >
              <Upload size={16} />
              替换为新版本
            </button>
            <p className="cg-muted">关闭此面板返回方案，保留原来的阅读位置。</p>
          </>
        ) : (
          <>
            <p>
              参考材料用于检查方案中的具体主张。支持 TXT、Markdown、DOCX，每份不超过 5
              MB，提取后的文本不超过 50,000 字符。
            </p>
            <button
              className="cg-primary"
              disabled={busy}
              onClick={() => {
                setReplaceId('');
                onUpload();
              }}
            >
              <Plus size={16} />
              添加材料
            </button>
            <div className="cg-material-list">
              {task.sources.map((s) => (
                <button key={s.id} onClick={() => setSourceId(s.id)}>
                  <FileText size={18} />
                  <span>
                    {s.name}
                    <small>
                      v{s.version} · {s.text.length} 字符
                    </small>
                  </span>
                  <ExternalLink size={14} />
                </button>
              ))}
            </div>
            <p className="cg-muted">
              材料更新保留旧版引用。DOCX 仅提取文本，不保留分页、图片、批注与版式。
            </p>
          </>
        )}
      </>
    )
  );
}
