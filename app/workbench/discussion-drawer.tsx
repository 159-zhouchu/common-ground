import type { ReactNode } from 'react';
import { Loader2, Square } from 'lucide-react';
import type { Task, Run, PublicConnection } from '@/lib/types';
import { runFeedback } from '@/lib/presentation';
import { date } from './format';
type Props = {
  task: Task;
  active?: Run;
  latest?: Run;
  busy: boolean;
  available: PublicConnection[];
  receiver: string;
  question: string;
  setReceiver: (value: string) => void;
  setQuestion: (value: string) => void;
  onRememberReceiver: (value: string) => void;
  connectionOptions: (value: string) => ReactNode;
  send: () => void;
  onStop: () => void;
  onActivity: () => void;
};
export function DiscussionDrawer({
  task,
  active,
  latest,
  busy,
  available,
  receiver,
  question,
  setReceiver,
  setQuestion,
  onRememberReceiver,
  connectionOptions,
  send,
  onStop,
  onActivity,
}: Props) {
  return (
    task && (
      <div className="cg-form">
        {active && (
          <div className="cg-running" role="status">
            <span>
              <Loader2 size={16} className="spin" />
              AI 思考中… {runFeedback(active, task.findings).detail}
            </span>
            <button className="cg-secondary" disabled={busy} onClick={() => onStop()}>
              <Square size={13} />
              停止
            </button>
          </div>
        )}
        {latest &&
          !active &&
          ['failed', 'partial', 'cancelled', 'interrupted'].includes(latest.state) && (
            <div className="cg-alert warning" role="status">
              <b>{runFeedback(latest, task.findings).title}</b>
              <p>{runFeedback(latest, task.findings).detail}</p>
              <button className="cg-text-button" onClick={() => onActivity()}>
                查看调用记录
              </button>
            </div>
          )}
        <p>点名谁，只由谁回答；下一次调用传入获准历史。</p>
        {task.messages.map((m) => (
          <section key={m.id} className={'cg-message ' + m.actor}>
            <b>{m.actor === 'user' ? '你' : m.model || 'AI'}</b>
            <small>{date(m.createdAt)}</small>
            <p>{m.content}</p>
          </section>
        ))}
        <label>
          接收者
          <select
            aria-label="选择被点名的模型"
            value={receiver}
            onChange={(e) => {
              setReceiver(e.target.value);
              onRememberReceiver(e.target.value);
            }}
          >
            {connectionOptions(receiver)}
          </select>
        </label>
        <textarea
          aria-label="讨论内容"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (
                !busy &&
                !active &&
                available.some((c) => c.connectionId === receiver && c.configured)
              )
                send();
            }
          }}
          rows={4}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="继续提问…"
        />
        <p className="cg-muted">
          Ctrl / ⌘ + Enter 发送。将发起真实模型调用，按量计费；未配置连接会先被阻止。
        </p>
        <button
          className="cg-primary"
          disabled={
            busy ||
            !!active ||
            !question.trim() ||
            !available.some((c) => c.connectionId === receiver && c.configured)
          }
          onClick={send}
        >
          发送给指定模型
        </button>
      </div>
    )
  );
}
