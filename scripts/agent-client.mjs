import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export function localBase(value = process.env.CG_BASE_URL || 'http://127.0.0.1:3210') {
  const url = new URL(value);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('CG_BASE_URL 必须是本机 HTTP 服务根地址。');
  return url.origin;
}
export async function request(route, body, base = localBase()) {
  const response = await fetch(base + '/api/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      `本机接口返回非 JSON 响应（HTTP ${response.status}），请核对端口、服务及代理设置。`,
    );
  }
  if (!response.ok) throw new Error(data.error || `本机接口返回 ${response.status}`);
  return data;
}
export async function waitJob(id, waitMs = 45000, base = localBase()) {
  const deadline = Date.now() + Math.max(0, Math.min(waitMs, 50000));
  let job;
  do {
    job = await request('agent/jobs/' + encodeURIComponent(id), undefined, base);
    if (job.state !== 'running' || Date.now() >= deadline) return job;
    await new Promise((r) => setTimeout(r, Math.min(750, Math.max(0, deadline - Date.now()))));
  } while (true);
}
export function brief(job) {
  const lines = [
    `# Agent 执行简报`,
    `任务：${job.goal}`,
    `协作 ID：${job.id}`,
    `阶段：${job.phase}；状态：${job.state}；执行判断：${job.decision}`,
    `说明：模型建议未在本机执行。保留执行方现有权限；自行核对文件与测试。`,
  ];
  for (const step of job.steps) {
    lines.push(
      `## ${step.role} · ${step.connection.label} · ${step.connection.model}`,
      `状态：${step.state}；已发送：${step.sent}；估算 USD：${step.cost ?? '未知'}`,
      step.error || '',
    );
    if (step.output) lines.push(step.output.summary);
  }
  if (job.result) {
    lines.push('## 下一步', job.result.summary);
    for (const s of job.result.steps)
      lines.push(
        `- ${s.task}`,
        `  文件：${s.files.join('、') || '未指定'}`,
        `  验证：${s.checks.join('；') || '待执行方补充'}`,
      );
    lines.push(
      '## 风险',
      ...job.result.risks.map((x) => '- ' + x),
      '## 待确认',
      ...job.result.questions.map((x) => '- ' + x),
    );
  }
  if (job.error) lines.push('错误：' + job.error);
  return lines.filter(Boolean).join('\n\n') + '\n';
}
function sensitivePath(relative) {
  return relative
    .split(/[\\/]/)
    .some((part) =>
      /^(?:\.env.*|\.data|\.git|\.gitconfig|\.codex|\.ssh|\.aws|\.npmrc|\.netrc|_netrc|\.git-credentials|\.pgpass|\.docker|\.kube|\.config|\.azure|\.gnupg|\.m2|\.gradle|\.terraform\.d|\.terraformrc|credentials\.tfrc\.json|.*\.tfstate(?:\.backup)?|\.pypirc|\.vault-token|\.s3cfg|\.databrickscfg|\.my\.cnf|gcloud|application_default_credentials\.json|service[-_]?account.*\.json|logins\.json|key\d\.db|cert\d\.db|cookies\.sqlite(?:-(?:wal|shm))?|\.bash_history|\.zsh_history|\.yarnrc(?:\..*)?|node_modules|workspace\.json|credentials?\.json|auth\.json|client_secret\.json|secrets?\.json|token\.json|cookies?|login data|local state|web data|agent-jobs\.json|server-owner\.json|server\.pid|launcher\.lock|connections(?:-v1)?\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|crt|p12|pfx|bak|tmp|log))$/i.test(
        part,
      ),
    );
}
export async function requestRoot(file) {
  const absolute = path.resolve(file);
  if (sensitivePath(absolute) || absolute.slice(path.parse(absolute).root.length).includes(':'))
    throw new Error('请求文件不能位于敏感目录、使用敏感文件名或备用数据流。');
  const root = await fs.realpath(path.dirname(absolute));
  const real = await fs.realpath(absolute);
  if (sensitivePath(real)) throw new Error('请求文件不能指向敏感目录或文件。');
  if (path.dirname(real) !== root) throw new Error('请求文件不能通过符号链接越出所在目录。');
  return { root, absolute: real };
}
export async function scopedFile(root, name, output = false) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.includes('\0') ||
    name.slice(path.parse(name).root.length).includes(':')
  )
    throw new Error('文件路径无效。');
  const resolved = path.resolve(root, name);
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative) ||
    sensitivePath(resolved)
  )
    throw new Error('文件必须位于请求文件所在目录内，且不能是密钥或本机私有配置。');
  const real = output
    ? path.join(await fs.realpath(path.dirname(resolved)), path.basename(resolved))
    : await fs.realpath(resolved);
  const realRelative = path.relative(root, real);
  if (
    realRelative === '..' ||
    realRelative.startsWith('..' + path.sep) ||
    path.isAbsolute(realRelative) ||
    sensitivePath(real)
  )
    throw new Error('文件符号链接越出目录或指向敏感配置。');
  return real;
}
// The explicit request directory bounds file inclusion, not an untrusted agent's OS permissions.
async function readScopedText(root, name) {
  const resolved = await scopedFile(root, name);
  const expected = await fs.lstat(resolved);
  if (!expected.isFile() || expected.nlink !== 1 || expected.size > 100000)
    throw new Error('仅允许小于 100 KB、无硬链接的普通 UTF-8 文本文件：' + name);
  const file = await fs.open(
    resolved,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 100000 ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino
    )
      throw new Error('仅允许小于 100 KB、无硬链接的普通 UTF-8 文本文件：' + name);
    // Read through the same verified handle, with a bound even if it grows.
    const buffer = Buffer.alloc(100001);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 100000) throw new Error('文本文件超过 100 KB：' + name);
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally {
    await file.close();
  }
}
export async function loadRequest(file) {
  const { root, absolute } = await requestRoot(file);
  const data = JSON.parse(await readScopedText(root, path.basename(absolute)));
  const { files = [], ...input } = data;
  if (!Array.isArray(files) || files.length > 20)
    throw new Error('files 最多列 20 个 UTF-8 文本文件。');
  const context = [...(input.context || [])];
  for (const name of files) {
    if (typeof name !== 'string') throw new Error('files 项必须是文件路径。');
    const content = await readScopedText(root, name);
    context.push({ name, content });
  }
  return { ...input, context, idempotencyKey: input.idempotencyKey || randomUUID() };
}
