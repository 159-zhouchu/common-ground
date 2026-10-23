import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function writeAtomic(target: string, data: unknown) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = target + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, target);
        break;
      } catch (error) {
        if (
          attempt >= 3 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code || '')
        )
          throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* Cleanup is best effort; preserve the original write/rename error. */
    }
  }
}
