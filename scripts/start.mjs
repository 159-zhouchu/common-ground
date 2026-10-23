import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  alive,
  health,
  occupied,
  readJSON,
  writeOwner,
  clearOwner,
  matches,
  delay,
} from './launcher-state.mjs';
import './check-node.mjs';
import { acquireLauncherLock } from './launcher-lock.mjs';

const port = Number(process.env.CG_PORT || 3210),
  url = `http://127.0.0.1:${port}`,
  dir = path.resolve(process.env.CG_DATA_DIR || '.data');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CG_PORT 无效');
fs.mkdirSync(dir, { recursive: true });
const lockFile = path.join(dir, 'launcher.lock');
async function main() {
  const releaseLock = acquireLauncherLock(lockFile);
  try {
    const old = readJSON(path.join(dir, 'server-owner.json'));
    if (await occupied(port)) {
      const h = await health(port);
      if (old?.port === port && matches(old, h)) {
        console.log('共桌已在运行：' + url);
        return;
      }
      throw new Error(`端口 ${port} 已被其他程序或另一工作区占用；未停止或修改该程序。`);
    }
    if (old && alive(old.pid))
      throw new Error('原启动进程仍存在但服务未就绪；请先停止原实例，启动记录已保留。');
    const next = path.resolve('node_modules/next/dist/bin/next'),
      instance = randomUUID(),
      token = randomBytes(32).toString('hex');
    const log = fs.openSync(path.join(dir, 'server.log'), 'a', 0o600);
    let server;
    try {
      server = spawn(process.execPath, [next, 'start', '-H', '127.0.0.1', '-p', String(port)], {
        cwd: process.cwd(),
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log, log],
        env: {
          ...process.env,
          CG_DATA_DIR: dir,
          CG_INSTANCE_ID: instance,
          CG_LAUNCHER_TOKEN: token,
          NEXT_TELEMETRY_DISABLED: '1',
        },
      });
    } finally {
      fs.closeSync(log);
    }
    let failure;
    server.on('error', (e) => (failure = e.message));
    server.unref();
    const owner = { pid: server.pid, instance, port, token };
    try {
      if (server.pid) writeOwner(dir, owner);
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (failure || server.exitCode !== null) break;
        if (matches(owner, await health(port))) {
          console.log('共桌已启动：' + url);
          return;
        }
        await delay(200);
      }
      throw new Error(
        '启动失败：' +
          (failure || '服务提前退出或未在 20 秒内就绪') +
          '。日志：' +
          path.join(dir, 'server.log'),
      );
    } catch (error) {
      // This ChildProcess handle is the child we just spawned, not an arbitrary PID.
      try {
        server.kill();
      } catch {}
      for (let i = 0; i < 30 && alive(server.pid); i++) await delay(100);
      if (!alive(server.pid)) clearOwner(dir, owner);
      throw error;
    }
  } finally {
    releaseLock();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
