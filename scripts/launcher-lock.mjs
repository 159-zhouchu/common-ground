import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { processIdentity, recordedProcessAlive, readJSON } from './launcher-state.mjs';

const incompleteGraceMs = 5000;
const busy = () => new Error('启动器正在工作或锁记录正在写入，请等待 5 秒后重试。');

function sameFile(left, right) {
  return (
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function acquireLauncherLock(file) {
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const before = fs.statSync(file);
        const previous = readJSON(file);
        const validPid = Number.isSafeInteger(previous?.pid) && previous.pid > 0;
        // Keep live/unknown owners; recover a record only when demonstrably stale.
        if (
          validPid
            ? recordedProcessAlive(previous)
            : Date.now() - before.mtimeMs < incompleteGraceMs
        )
          throw busy();
        // Do not remove a record that changed while it was being inspected.
        if (!sameFile(before, fs.statSync(file))) continue;
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      continue;
    }
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, token, identity: processIdentity(process.pid) }),
      );
    } catch (error) {
      fs.closeSync(fd);
      fs.rmSync(file, { force: true });
      throw error;
    }
    fs.closeSync(fd);
    return () => {
      if (readJSON(file)?.token === token) fs.rmSync(file, { force: true });
    };
  }
  throw busy();
}
