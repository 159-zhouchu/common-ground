import { MAX_CONCURRENT_REQUESTS } from './limits';
const state = globalThis as typeof globalThis & {
  cgExecution?: { active: number; locks: Map<string, number>; queue: Set<() => void> };
  cgTaskLocks?: Map<string, number>;
};
const gate = (state.cgExecution ??= { active: 0, locks: new Map(), queue: new Set() });
export function lockConnections(ids: string[]) {
  const unique = [...new Set(ids)];
  for (const id of unique) gate.locks.set(id, (gate.locks.get(id) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of unique) {
      const count = (gate.locks.get(id) || 1) - 1;
      if (count) gate.locks.set(id, count);
      else gate.locks.delete(id);
    }
  };
}
export const connectionInUse = (id: string) => !!gate.locks.get(id);
export async function limitedRequest<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  if (gate.active >= MAX_CONCURRENT_REQUESTS || gate.queue.size) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        cleanup();
        gate.active++;
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(new DOMException('Request cancelled', 'AbortError'));
      };
      const cleanup = () => {
        gate.queue.delete(wake);
        signal.removeEventListener('abort', abort);
      };
      gate.queue.add(wake);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  } else gate.active++;
  try {
    signal.throwIfAborted();
    return await fn();
  } finally {
    gate.active--;
    const wake = gate.queue.values().next().value;
    wake?.();
  }
}

const taskLocks = (state.cgTaskLocks ??= new Map<string, number>());
export const taskInFlight = (id: string) => !!taskLocks.get(id);
export function lockTask(id: string) {
  taskLocks.set(id, (taskLocks.get(id) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (taskLocks.get(id) || 1) - 1;
    if (n) taskLocks.set(id, n);
    else taskLocks.delete(id);
  };
}
