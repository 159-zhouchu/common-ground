import fs from 'node:fs';
import path from 'node:path';
import {
  alive,
  health,
  occupied,
  readJSON,
  clearOwner,
  matches,
  delay,
} from './launcher-state.mjs';

const dir = path.resolve(process.env.CG_DATA_DIR || '.data'),
  pidFile = path.join(dir, 'server.pid'),
  owner = readJSON(path.join(dir, 'server-owner.json'));
async function main() {
  if (!owner) {
    if (fs.existsSync(pidFile)) {
      const port = Number(process.env.CG_PORT || 3210);
      if ((await health(port))?.app === 'common-ground')
        throw new Error(
          '缺少有效启动凭据，不能安全停止当前服务；记录已保留。终端服务请按 Ctrl+C。',
        );
      fs.rmSync(pidFile, { force: true });
    }
    console.log('共桌已停止，或由终端启动；终端服务请按 Ctrl+C。');
    return;
  }
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1 ||
    !Number.isInteger(owner.port) ||
    owner.port < 1 ||
    owner.port > 65535
  )
    throw new Error('启动记录格式无效，未发送停止请求；记录已保留。');
  const h = await health(owner.port);
  if (!h && !alive(owner.pid)) {
    clearOwner(dir, owner);
    console.log('共桌已停止；已清理过期启动记录。');
    return;
  }
  if (!matches(owner, h) || !alive(owner.pid))
    throw new Error('启动记录与当前服务不匹配，未停止任何程序；记录已保留。');
  if (!/^[a-f0-9]{64}$/.test(owner.token || ''))
    throw new Error(
      '这是旧版启动记录，缺少停止凭据；请先用旧版停止脚本关闭服务，再使用新版启动器。记录已保留。',
    );
  const response = await fetch(`http://127.0.0.1:${owner.port}/api/launcher/stop`, {
    method: 'POST',
    headers: {
      'x-cg-launcher-token': owner.token,
      'x-cg-instance': owner.instance,
      'x-cg-pid': String(owner.pid),
    },
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
  });
  await response.body?.cancel();
  if (response.status !== 202)
    throw new Error(`服务拒绝停止（HTTP ${response.status}）；启动记录已保留。`);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (!alive(owner.pid) && !(await occupied(owner.port))) {
      clearOwner(dir, owner);
      console.log('共桌已停止。项目及密钥仍保存在本机数据目录。');
      return;
    }
    await delay(150);
  }
  throw new Error(
    '停止尚未完成：进程或端口仍在使用。启动记录已保留，可稍后重试；未强制终止其他程序。',
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
