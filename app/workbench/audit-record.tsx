import { useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import { stepManifest } from '@/lib/run-audit';
import type { RunAudit } from '@/lib/task-views';

export function AuditRecord({
  taskId,
  runId,
  updatedAt,
}: {
  taskId: string;
  runId: string;
  updatedAt: string;
}) {
  const [open, setOpen] = useState(false),
    [retry, setRetry] = useState(0);
  const [data, setData] = useState<RunAudit | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    setData(null);
    setError('');
    api(
      `task-detail?view=audit&taskId=${encodeURIComponent(taskId)}&runId=${encodeURIComponent(runId)}`,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, taskId, runId, updatedAt, retry]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>完整输入、输出与请求记录</summary>
      {open &&
        (error ? (
          <p role="alert">
            {error}
            <button onClick={() => setRetry((n) => n + 1)}>重试读取记录</button>
          </p>
        ) : data ? (
          <pre>
            {JSON.stringify(
              {
                ...data.run,
                steps: data.run.steps.map((step) => ({
                  ...step,
                  manifest: stepManifest(data.run, step),
                })),
              },
              null,
              2,
            )}
          </pre>
        ) : (
          <p role="status">正在读取本次调用记录…</p>
        ))}
    </details>
  );
}
