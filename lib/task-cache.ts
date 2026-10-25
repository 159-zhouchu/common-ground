import type { TaskContent } from './task-views';

// Browser memory only: bounded entries/bytes, never persisted alongside authored drafts.
export function taskCache(maxEntries = 4, maxBytes = 5 * 1024 * 1024) {
  const entries = new Map<string, { value: TaskContent; bytes: number }>();
  let bytes = 0;
  const key = (id: string, updatedAt: string, view: TaskContent['contentView']) =>
    JSON.stringify([id, updatedAt, view]);
  return {
    get(id: string, updatedAt: string, view: TaskContent['contentView']) {
      const k = key(id, updatedAt, view),
        entry = entries.get(k);
      if (entry) {
        entries.delete(k);
        entries.set(k, entry);
      }
      return entry?.value;
    },
    put(value: TaskContent) {
      const k = key(value.id, value.updatedAt, value.contentView);
      for (const [oldKey, old] of entries)
        if (
          old.value.id === value.id &&
          (old.value.updatedAt !== value.updatedAt || oldKey === k)
        ) {
          entries.delete(oldKey);
          bytes -= old.bytes;
        }
      const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (size > maxBytes) return;
      entries.set(k, { value, bytes: size });
      bytes += size;
      while (entries.size > maxEntries || bytes > maxBytes) {
        const oldest = entries.entries().next().value!;
        entries.delete(oldest[0]);
        bytes -= oldest[1].bytes;
      }
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
  };
}
