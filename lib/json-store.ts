import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './atomic-file';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from './domain';

type Entry = {
  value?: unknown;
  stamp?: string;
  initialized: boolean;
  writing: boolean;
  backupAt?: number;
};
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
  validate: (value: T) => boolean = () => true,
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
        let value: T;
        try {
          value = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
          if (!validate(value)) throw new Error('Invalid shape');
        } catch {
          // Never replace a corrupt primary with cached or seeded content.
          throw new AppError(
            'STORAGE_CORRUPT',
            `${path.basename(file)} 无法读取或格式损坏；原文件未修改。请停止服务并按恢复说明核对 .bak 备份。`,
            503,
          );
        }
        if (!entry.initialized && recover(value)) writeAtomic(file, value);
        entry.value = value;
        entry.stamp = stamp(file);
        entry.initialized = true;
      }
    }
    return entry.value as T;
  }

  return {
    revisionTag() {
      load();
      return entry.stamp!;
    },
    read<R = T>(select: (value: Readonly<T>) => R = (value) => value as R): R {
      // Never expose a mutable cached reference (including nested values).
      return structuredClone(select(load()));
    },
    transact<R>(change: (value: T) => R): R {
      if (entry.writing) throw new Error('存储事务不能嵌套写入。');
      entry.writing = true;
      try {
        const before = load();
        const draft = structuredClone(before);
        const result = change(draft);
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          throw new Error('存储事务回调必须同步完成，不能返回 Promise。');
        }
        // Clone before committing so returned values cannot mutate the cache.
        const detached = structuredClone(result);
        if (isDeepStrictEqual(before, draft)) return detached;
        // Keep one known-good checkpoint, at most once a minute.
        if (!entry.backupAt || Date.now() - entry.backupAt >= 60000) {
          try {
            fs.copyFileSync(file, file + '.bak');
            if (process.platform !== 'win32') fs.chmodSync(file + '.bak', 0o600);
          } catch (error) {
            // Backups are best effort; a locked checkpoint must not block primary commits.
            console.warn({
              code: 'CHECKPOINT_FAILED',
              file: path.basename(file),
              reason: (error as NodeJS.ErrnoException).code || 'UNKNOWN',
            });
          }
          entry.backupAt = Date.now();
        }
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
