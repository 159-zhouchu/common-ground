import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return true;
  }
  // A terminated POSIX child can remain as a zombie until its parent reaps it.
  if (process.platform !== 'win32') {
    try {
      return !/^Z/.test(
        execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
          encoding: 'utf8',
          timeout: 2000,
        }).trim(),
      );
    } catch {
      /* Unknown state must not be treated as permission to kill. */
    }
  }
  return true;
}
export async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
      redirect: 'error',
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
export function occupied(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const end = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => end(true));
    socket.once('error', () => end(false));
    socket.setTimeout(600, () => end(true));
  });
}
export function matches(owner, h) {
  return (
    !!owner && owner.instance === h?.instance && owner.pid === h?.pid && h?.app === 'common-ground'
  );
}
export function writeOwner(dir, owner) {
  const temp = path.join(dir, `server-owner.${owner.instance}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, path.join(dir, 'server-owner.json'));
  } finally {
    fs.rmSync(temp, { force: true });
  }
  fs.writeFileSync(path.join(dir, 'server.pid'), String(owner.pid), { mode: 0o600 });
}
export function clearOwner(dir, owner) {
  // A second launcher must never have its records removed by an older command.
  const file = path.join(dir, 'server-owner.json'),
    latest = readJSON(file);
  if (latest?.instance !== owner?.instance || latest?.pid !== owner?.pid) return;
  fs.rmSync(file, { force: true });
  fs.rmSync(path.join(dir, 'server.pid'), { force: true });
}
