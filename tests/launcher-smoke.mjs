// Real production Next process; isolated data and port, no model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { freePort } from './local-server.mjs';
import { writeReport } from './write-report.mjs';
import { alive } from '../scripts/launcher-state.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-launcher-'));
const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-launcher-other-'));
const port = await freePort(),
  base = `http://127.0.0.1:${port}`;
const env = { ...process.env, CG_DATA_DIR: dir, CG_PORT: String(port) };
const ownerFile = path.join(dir, 'server-owner.json'),
  pidFile = path.join(dir, 'server.pid');
const checks = [];
let ownedPid, blocker;
function command(script, extra = {}) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(process.execPath, [`scripts/${script}.mjs`], {
      env: { ...env, ...extra },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(script + ' timed out'));
    }, 35000);
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
async function health() {
  try {
    const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) });
    return await response.json();
  } catch {
    return null;
  }
}
function write(owner) {
  fs.writeFileSync(ownerFile, JSON.stringify(owner));
}
async function denied(headers) {
  const response = await fetch(base + '/api/launcher/stop', { method: 'POST', headers });
  assert.equal(response.status, 403);
  assert.ok(await health());
}
try {
  const lockFile = path.join(dir, 'launcher.lock');
  fs.writeFileSync(lockFile, '');
  const recent = await command('start');
  assert.equal(recent.code, 1, recent.output);
  assert.match(recent.output, /等待 5 秒/);
  assert.equal(fs.existsSync(ownerFile), false);
  checks.push('新建空锁保留短暂宽限，不抢占可能仍在写入的启动器');
  const oldTime = new Date(Date.now() - 30000);
  fs.utimesSync(lockFile, oldTime, oldTime);
  const starts = await Promise.all([command('start'), command('start')]);
  assert.ok(
    starts.some((r) => r.code === 0),
    JSON.stringify(starts),
  );
  for (const r of starts)
    assert.ok(r.code === 0 || (r.code === 1 && /启动器正在工作/.test(r.output)), r.output);
  checks.push('旧空锁崩溃恢复且两个启动器并发：最多启动一个实例，另一个复用或明确提示等待');
  let result;
  let owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  ownedPid = owner.pid;
  assert.equal(Number(fs.readFileSync(pidFile, 'utf8')), ownedPid);
  assert.equal(owner.port, port);
  assert.equal((await health()).instance, owner.instance);
  assert.equal((await health()).pid, ownedPid);
  assert.match(owner.token, /^[a-f0-9]{64}$/);
  assert.ok(fs.existsSync(path.join(dir, 'server.log')));
  assert.ok(!JSON.stringify(await health()).includes(owner.token));
  checks.push('真实 Next 生产服务：随机端口、临时数据、PID/实例一致，停止凭据不公开');
  const headers = {
    'x-cg-launcher-token': owner.token,
    'x-cg-instance': owner.instance,
    'x-cg-pid': String(owner.pid),
  };
  await denied({});
  await denied({ ...headers, 'x-cg-launcher-token': '0'.repeat(64) });
  await denied({ ...headers, 'x-cg-instance': 'wrong' });
  await denied({ ...headers, 'x-cg-pid': String(process.pid) });
  checks.push('缺失/错误凭据、实例或 PID 均不能停止服务');
  await denied({ ...headers, Origin: 'https://unrelated.invalid' });
  await denied({ ...headers, 'Sec-Fetch-Site': 'cross-site' });
  checks.push('即使凭据正确，跨站停止请求仍被拒绝');
  result = await command('start');
  assert.equal(result.code, 0, result.output);
  assert.equal(Number(fs.readFileSync(pidFile, 'utf8')), ownedPid);
  checks.push('重复启动复用原实例');
  result = await command('start', { CG_DATA_DIR: otherDir });
  assert.equal(result.code, 1, result.output);
  assert.ok(!fs.existsSync(path.join(otherDir, 'server-owner.json')));
  checks.push('另一数据目录不能误认并接管当前端口');
  write({ ...owner, pid: process.pid });
  result = await command('stop');
  assert.equal(result.code, 1, result.output);
  assert.ok(fs.existsSync(ownerFile));
  process.kill(process.pid, 0);
  assert.ok(await health());
  write(owner);
  checks.push('记录指向无关 PID 时拒绝操作并保留记录');
  write({ ...owner, token: '0'.repeat(64) });
  result = await command('stop');
  assert.equal(result.code, 1, result.output);
  assert.ok(fs.existsSync(ownerFile));
  assert.ok(await health());
  write(owner);
  checks.push('记录凭据失效时不谎报成功、不丢记录');
  const { token, ...legacy } = owner;
  write(legacy);
  result = await command('stop');
  assert.equal(result.code, 1, result.output);
  assert.ok(fs.existsSync(ownerFile));
  assert.ok(await health());
  write(owner);
  checks.push('旧版无凭据记录明确拒绝，保留恢复线索');
  result = await command('stop', { CG_PORT: String(await freePort()) });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /共桌已停止。/);
  assert.equal(await health(), null);
  assert.equal(alive(ownedPid), false);
  ownedPid = undefined;
  assert.ok(!fs.existsSync(pidFile));
  assert.ok(!fs.existsSync(ownerFile));
  checks.push('按记录端口停止真实 Next，确认进程退出和端口关闭后才清理记录');
  const connectionsFile = path.join(dir, 'connections.json');
  fs.writeFileSync(connectionsFile, '{degraded-test');
  result = await command('start');
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /部分本机存储不可用/);
  ownedPid = JSON.parse(fs.readFileSync(ownerFile, 'utf8')).pid;
  assert.equal((await health()).ready, false);
  assert.equal(fs.readFileSync(connectionsFile, 'utf8'), '{degraded-test');
  result = await command('stop');
  assert.equal(result.code, 0, result.output);
  assert.equal(await health(), null);
  ownedPid = undefined;
  checks.push('连接存储损坏时启动器保留可运行的降级服务并允许正常停止');
  write({
    ...owner,
    pid: process.pid,
    identity: { birth: 'old-process-creation', executable: process.execPath },
  });
  result = await command('start');
  assert.equal(result.code, 0, result.output);
  process.kill(process.pid, 0);
  checks.push('PID 被复用但创建时间不同：清除过期启动阻塞，不终止现存进程');
  const second = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  ownedPid = second.pid;
  assert.notEqual(second.token, owner.token);
  assert.notEqual(second.instance, owner.instance);
  await denied(headers);
  owner = second;
  checks.push('重启生成新凭据，上一实例的请求不能停止新服务');
  fs.unlinkSync(pidFile);
  result = await command('stop');
  assert.equal(result.code, 0, result.output);
  assert.equal(await health(), null);
  assert.equal(alive(ownedPid), false);
  ownedPid = undefined;
  checks.push('兼容仅剩 owner 记录时停止，PID 文件缺失不遗留服务');
  result = await command('stop');
  assert.equal(result.code, 0, result.output);
  checks.push('重复停止幂等');
  write({
    ...owner,
    pid: process.pid,
    identity: { birth: 'old-process-creation', executable: process.execPath },
  });
  result = await command('stop');
  assert.equal(result.code, 0, result.output);
  process.kill(process.pid, 0);
  assert.equal(fs.existsSync(ownerFile), false);
  checks.push('过期 owner 指向复用 PID 时只清理记录，不发送信号给该进程');
  fs.writeFileSync(pidFile, String(process.pid));
  result = await command('stop');
  assert.equal(result.code, 0, result.output);
  assert.ok(!fs.existsSync(pidFile));
  process.kill(process.pid, 0);
  checks.push('孤立 PID 记录只清理记录，不终止无关进程');
  blocker = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: 'unrelated-local-test' }));
  });
  await new Promise((resolve, reject) =>
    blocker.once('error', reject).listen(port, '127.0.0.1', resolve),
  );
  result = await command('start');
  assert.equal(result.code, 1, result.output);
  assert.equal((await health()).app, 'unrelated-local-test');
  assert.ok(!fs.existsSync(pidFile));
  checks.push('其他服务占用端口时不启动、不终止该服务');
  await new Promise((resolve) => blocker.close(resolve));
  blocker = null;
  // A service acknowledges but does not exit. Stop must fail and retain ownership.
  const stuck = { pid: process.pid, instance: 'stuck-test', port, token: '1'.repeat(64) };
  blocker = http.createServer((req, res) => {
    res.writeHead(req.method === 'POST' ? 202 : 200, {
      'Content-Type': 'application/json',
      Connection: 'close',
    });
    res.end(
      JSON.stringify(
        req.method === 'POST'
          ? { stopping: true }
          : { app: 'common-ground', pid: stuck.pid, instance: stuck.instance },
      ),
    );
  });
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  write(stuck);
  fs.writeFileSync(pidFile, String(process.pid));
  result = await command('stop');
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /停止尚未完成/);
  assert.ok(fs.existsSync(ownerFile));
  assert.ok(fs.existsSync(pidFile));
  process.kill(process.pid, 0);
  checks.push('服务接受停止但不退出：超时返回失败并保留全部启动记录');
  const report = {
    at: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    scope:
      '真实 Next 生产进程及独立临时数据/随机端口；无用户数据、无付费调用；未运行的平台不视为通过',
    passed: checks.length,
    checks,
  };
  writeReport('launcher-checks.json', report);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (ownedPid)
    try {
      process.kill(ownedPid);
    } catch {}
  if (blocker) await new Promise((resolve) => blocker.close(resolve));
  for (const temporary of [dir, otherDir]) {
    const resolved = path.resolve(temporary);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
      throw new Error('Temporary directory boundary check failed');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
