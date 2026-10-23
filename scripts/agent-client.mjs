import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
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
  const data = await response.json();
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
// Only explicitly listed UTF-8 files are read; no directory scanning or shell execution.
export async function loadRequest(file) {
  const absolute = path.resolve(file);
  const data = JSON.parse(await fs.readFile(absolute, 'utf8'));
  const { files = [], ...input } = data;
  if (!Array.isArray(files) || files.length > 20)
    throw new Error('files 最多列 20 个 UTF-8 文本文件。');
  const context = [...(input.context || [])];
  for (const name of files) {
    if (typeof name !== 'string') throw new Error('files 项必须是文件路径。');
    const resolved = path.resolve(path.dirname(absolute), name),
      stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 100000)
      throw new Error('上下文必须是小于 100 KB 的文本文件：' + name);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(resolved));
    context.push({ name, content });
  }
  return { ...input, context, idempotencyKey: input.idempotencyKey || randomUUID() };
}
