import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './atomic-file';

type Entry = { value?: unknown; stamp?: string; initialized: boolean; writing: boolean };
const shared = globalThis as typeof globalThis & { cgJsonFiles?: Map<string, Entry> };
const files = (shared.cgJsonFiles ??= new Map<string, Entry>());

function stamp(file: string) {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

// Single-process storage: cache parsed JSON, but acknowledge mutations only after
// an atomic disk commit. No delayed flush, silent data loss window or async hooks.
export function jsonStore<T>(
  target: string,
  create: () => T,
  recover: (value: T) => boolean = () => false,
) {
  const file = path.resolve(target);
  const entry = files.get(file) ?? { initialized: false, writing: false };
  files.set(file, entry);

  function load(): T {
    if (!fs.existsSync(file)) {
      const value = create();
      writeAtomic(file, value);
      entry.value = value;
      entry.stamp = stamp(file);
      entry.initialized = true;
    } else {
      const current = stamp(file);
      if (entry.value === undefined || entry.stamp !== current) {
        const value = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
        if (!entry.initialized && recover(value)) writeAtomic(file, value);
        entry.value = value;
        entry.stamp = stamp(file);
        entry.initialized = true;
      }
    }
    return entry.value as T;
  }

  return {
    read<R = T>(select: (value: Readonly<T>) => R = (value) => value as R): R {
      // Never expose a mutable cached reference (including nested values).
      return structuredClone(select(load()));
    },
    transact<R>(change: (value: T) => R): R {
      if (entry.writing) throw new Error('存储事务不能嵌套写入。');
      entry.writing = true;
      try {
        const draft = structuredClone(load());
        const result = change(draft);
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          throw new Error('存储事务回调必须同步完成，不能返回 Promise。');
        }
        // Clone before committing so returned values cannot mutate the cache.
        const detached = structuredClone(result);
        writeAtomic(file, draft);
        entry.value = structuredClone(draft);
        entry.stamp = stamp(file);
        return detached;
      } finally {
        entry.writing = false;
      }
    },
  };
}
