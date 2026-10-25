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
// A PID alone can refer to a different process after reuse. Unknown identity
// remains conservative; this function never signals or terminates a process.
export function processIdentity(pid, platform = process.platform, execute = execFileSync) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (platform === 'win32') {
      const raw = execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{ birth = $p.StartTime.ToUniversalTime().Ticks.ToString(); executable = $p.Path } | ConvertTo-Json -Compress`,
        ],
        { encoding: 'utf8', timeout: 3000, windowsHide: true },
      );
      const value = JSON.parse(raw);
      return value.birth && value.executable ? value : null;
    }
    if (platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return {
        birth: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + fields[19],
        executable: fs.readlinkSync(`/proc/${pid}/exe`),
      };
    }
    if (platform === 'darwin') {
      const raw = execute('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], {
        encoding: 'utf8',
        timeout: 2000,
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      }).trim();
      const match = /^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(raw);
      return match
        ? { birth: 'darwin:' + match[1].replace(/\s+/g, ' '), executable: match[2] }
        : null;
    }
    return null;
  } catch {
    return null;
  }
}
export function recordedProcessAlive(record) {
  if (!alive(record?.pid)) return false;
  const expected = record.identity;
  if (!expected?.birth || !expected?.executable) return true;
  const actual = processIdentity(record.pid);
  return !actual || (expected.birth === actual.birth && expected.executable === actual.executable);
}
export async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
      redirect: 'error',
    });
    // Readiness can fail while the authenticated stop endpoint remains usable.
    if (!r.ok && r.status !== 503) return null;
    const body = await r.json();
    return body?.app === 'common-ground' ? body : null;
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
