import { MAX_CONCURRENT_REQUESTS } from './limits';
const state = globalThis as typeof globalThis & {
  cgExecution?: { active: number; locks: Map<string, number>; queue: Set<() => void> };
};
const gate = (state.cgExecution ??= { active: 0, locks: new Map(), queue: new Set() });
export function lockConnections(ids: string[]) {
  const unique = [...new Set(ids)];
  for (const id of unique) gate.locks.set(id, (gate.locks.get(id) || 0) + 1);
  return () => {
    for (const id of unique) {
      const count = (gate.locks.get(id) || 1) - 1;
      if (count) gate.locks.set(id, count);
      else gate.locks.delete(id);
    }
  };
}
export const connectionInUse = (id: string) => !!gate.locks.get(id);
export async function limitedRequest<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  while (gate.active >= MAX_CONCURRENT_REQUESTS) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        cleanup();
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
  }
  signal.throwIfAborted();
  gate.active++;
  try {
    return await fn();
  } finally {
    gate.active--;
    for (const wake of [...gate.queue]) wake();
  }
}

const taskLocks = new Map<string, number>();
export const taskInFlight = (id: string) => !!taskLocks.get(id);
export function lockTask(id: string) {
  taskLocks.set(id, (taskLocks.get(id) || 0) + 1);
  return () => {
    const n = (taskLocks.get(id) || 1) - 1;
    if (n) taskLocks.set(id, n);
    else taskLocks.delete(id);
  };
}
