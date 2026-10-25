// Run after build. CG_PLAYWRIGHT_MODULE and CG_AXE_SOURCE may point to external QA tools.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { freePort, waitForInstance } from './local-server.mjs';
import { writeReport } from './write-report.mjs';

const require = createRequire(import.meta.url);
const { chromium } = await import(
  process.env.CG_PLAYWRIGHT_MODULE
    ? pathToFileURL(path.resolve(process.env.CG_PLAYWRIGHT_MODULE)).href
    : 'playwright'
);
const axeSource = fs.readFileSync(
  process.env.CG_AXE_SOURCE || require.resolve('axe-core/axe.min.js'),
  'utf8',
);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-detail-recovery-'));
const port = await freePort(),
  instance = randomUUID(),
  base = `http://127.0.0.1:${port}`;
const output =
  process.env.CG_TEST_REPORT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'cg-detail-report-'));
fs.mkdirSync(output, { recursive: true });
const server = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)],
  {
    env: {
      ...process.env,
      CG_DATA_DIR: dir,
      CG_INSTANCE_ID: instance,
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
);
let log = '',
  browser;
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
const checks = [],
  consoleErrors = [],
  pageErrors = [],
  axeChecks = [];
async function call(route, body) {
  const response = await fetch(base + '/api/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
}
try {
  await waitForInstance(base, instance, server, () => log);
  const workspace = await call('workspace');
  const exampleId = workspace.tasks[0].id;
  const other = await call('task', {
    title: 'Sprint 1 隔离项目',
    goal: '',
    constraint: '',
    content: '隔离正文，保存后必须保留。',
  });
  browser = await chromium.launch({
    channel: process.env.CG_BROWSER_CHANNEL || 'msedge',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('cg-started', 'true'));
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let mode = 'pass',
    poll = 'pass',
    releaseSlow;
  const detailRequests = [];
  await page.route('**/api/task-detail**', async (route) => {
    detailRequests.push(new URL(route.request().url()).searchParams.toString());
    const requestMode = mode;
    if (requestMode === '503')
      return route.fulfill({ status: 503, json: { error: '隔离注入：详情暂不可用' } });
    if (requestMode === 'slow')
      await new Promise((resolve) => {
        releaseSlow = resolve;
      });
    if (requestMode === 'timeout') await new Promise((resolve) => setTimeout(resolve, 22000));
    await route.continue().catch(() => {});
  });
  await page.route('**/api/workspace?view=summary', (route) => {
    if (poll === '503')
      return route.fulfill({ status: 503, json: { error: '隔离注入：工作区轮询失败' } });
    if (poll === '304') return route.fulfill({ status: 304, body: '' });
    return route.continue();
  });
  const ready = async () => {
    await page.locator('#current-document').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '材料', exact: true }).waitFor();
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="材料"]')?.disabled,
    );
  };
  const error = () => page.getByRole('heading', { name: '项目详情加载失败' }).first().waitFor();
  const retry = () =>
    page.getByRole('button', { name: '重试加载详情', exact: true }).first().click();
  async function more(name) {
    await page.getByLabel('更多', { exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
  }
  async function closeDrawer() {
    await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  }
  async function axe(label) {
    await page.evaluate(() => document.fonts.ready);
    // Let existing button color transitions finish before measuring contrast.
    await page.waitForTimeout(300);
    await page.evaluate(axeSource);
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run();
      return result.violations
        .filter((v) => ['serious', 'critical'].includes(v.impact))
        .map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) }));
    });
    axeChecks.push({ label, violations });
    assert.deepEqual(violations, [], `${label}: axe serious/critical`);
  }
  await page.goto(base);
  await ready();
  await axe('normal desktop');
  checks.push('正常首屏加载，axe 无 serious/critical');

  mode = '503';
  await page.reload();
  await error();
  assert.match(await page.locator('main').innerText(), /隔离注入：详情暂不可用/);
  assert.equal(await page.getByRole('button', { name: '开始检查', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '保存', exact: true }).count(), 0);
  await page.waitForResponse(
    (r) => r.url().includes('workspace?view=summary') && r.status() === 304,
    { timeout: 12000 },
  );
  await error();
  await more('使用帮助');
  await page.getByRole('dialog').waitFor();
  await closeDrawer();
  await more('API 设置');
  await page.getByRole('dialog').waitFor();
  await page.locator('.api-editor').waitFor();
  await page.waitForFunction(
    () => !!document.querySelector('.api-list-toolbar, .api-empty, .api-feedback.error'),
    null,
    { timeout: 15000 },
  );
  const addConnection = page.getByRole('button', { name: '新增连接', exact: true }).last();
  if (await addConnection.isVisible().catch(() => false)) await addConnection.click();
  else {
    const emptyAdd = page.getByRole('button', { name: '添加模型连接', exact: true }).last();
    await emptyAdd.scrollIntoViewIfNeeded();
    assert.ok(await emptyAdd.isVisible(), (await page.locator('body').innerText()).slice(-3000));
    await emptyAdd.click({ force: true });
  }
  await page.getByLabel('API Key', { exact: true }).waitFor();
  const apiKeyBounds = await page.locator('.api-secret-input input').boundingBox();
  const apiSecretBounds = await page.locator('.api-secret-input').boundingBox();
  assert.ok(apiKeyBounds && apiSecretBounds && apiKeyBounds.width >= apiSecretBounds.width - 2);
  await closeDrawer();
  await axe('detail 503 desktop');
  await page.screenshot({ path: path.join(output, 'detail-503-desktop.png'), fullPage: true });
  checks.push('详情 503 可见，304 不抹除错误；完整输入缺失时无开始/保存入口，帮助和设置可打开');
  await page.setViewportSize({ width: 390, height: 844 });
  await axe('detail 503 mobile');
  assert.ok(await page.getByRole('button', { name: '重试加载详情', exact: true }).isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, 'detail-503-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  mode = 'pass';
  await retry();
  await ready();
  checks.push('桌面和移动端错误与重试可见，重试成功恢复正文');

  mode = '503';
  await page.getByLabel(/^切换项目：/).click();
  await page
    .locator('.cg-project-picker')
    .getByRole('button')
    .filter({ hasText: workspace.tasks[0].title })
    .click();
  await error();
  mode = 'pass';
  await retry();
  await ready();
  checks.push('重新选择当前项目也会发起详情请求，失败可见且可重试恢复');
  const mainRequests = () =>
    detailRequests.filter(
      (query) =>
        new URLSearchParams(query).get('view') === 'main' &&
        new URLSearchParams(query).get('taskId') === exampleId,
    ).length;
  const beforeCache = mainRequests();
  await page.getByLabel(/^切换项目：/).click();
  await page
    .locator('.cg-project-picker')
    .getByRole('button', { name: other.title, exact: true })
    .click();
  await ready();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'current-document');
  await page.getByLabel(/^切换项目：/).click();
  await page
    .locator('.cg-project-picker')
    .getByRole('button')
    .filter({ hasText: workspace.tasks[0].title })
    .click();
  await ready();
  assert.equal(mainRequests(), beforeCache);
  checks.push('切回未更新项目命中 main 缓存，不重复读取详情');

  mode = 'slow';
  await page.reload();
  await page.getByRole('heading', { name: '正在加载项目详情' }).waitFor();
  assert.ok(await page.locator('[data-detail-skeleton]').isVisible());
  await more('项目管理与回收站');
  assert.ok(await page.getByRole('button', { name: '重命名', exact: true }).first().isEnabled());
  await closeDrawer();
  await page.screenshot({ path: path.join(output, 'detail-slow.png'), fullPage: true });
  mode = 'pass';
  releaseSlow();
  await ready();
  checks.push('慢响应显示骨架，项目管理未被全局禁用，响应到达后恢复');

  mode = 'timeout';
  await page.reload();
  await page.getByRole('heading', { name: '项目详情加载失败' }).waitFor({ timeout: 30000 });
  assert.match(await page.locator('main').innerText(), /超时/);
  mode = 'pass';
  await retry();
  await ready();
  checks.push('实际等待客户端 20 秒超时，显示错误，重试成功恢复');

  mode = 'slow';
  await page.reload();
  await page.getByRole('heading', { name: '正在加载项目详情' }).waitFor();
  await page.getByLabel(/^切换项目：/).click();
  mode = 'pass';
  await page
    .locator('.cg-project-picker')
    .getByRole('button', { name: other.title, exact: true })
    .click();
  releaseSlow();
  await ready();
  assert.match(await page.locator('#current-document').innerText(), /隔离正文/);
  assert.match(await page.locator('.cg-overview h1').innerText(), /Sprint 1 隔离项目/);
  checks.push('慢请求中仍可切换项目，旧响应不会覆盖新项目');

  await page
    .locator('.cg-document-toolbar')
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  const body = page.locator('.cg-block textarea').first();
  await body.fill('Sprint 1 保存后的正文仍在。');
  mode = '503';
  await page
    .locator('.cg-document-toolbar')
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await error();
  assert.equal(await page.locator('[data-detail-skeleton]').count(), 0);
  assert.ok(await page.getByRole('button', { name: '开始检查', exact: true }).isDisabled());
  assert.ok(
    await page
      .locator('.cg-document-toolbar')
      .getByRole('button', { name: '编辑', exact: true })
      .isDisabled(),
  );
  assert.ok(await page.locator('#current-document').isVisible());
  mode = 'pass';
  await retry();
  await page.getByText('Sprint 1 保存后的正文仍在。', { exact: true }).waitFor();
  const saved = await call('task-detail?taskId=' + other.id);
  assert.equal(saved.revisions.length, 2);
  checks.push('保存后刷新失败保留旧正文并禁用输入操作，重试显示已保存新版本且历史完整');

  poll = '503';
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('.cg-error').getByText('隔离注入：工作区轮询失败', { exact: true }).waitFor();
  poll = '304';
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('workspace?view=summary') && r.status() === 304),
    page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
  ]);
  assert.ok(await page.locator('.cg-error').isVisible());
  await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
  assert.equal(await page.locator('.cg-error').count(), 0);
  poll = 'pass';
  checks.push('工作区轮询错误不被 304 清除，关闭键清除实际显示的 pollError');

  await page.getByLabel(/^切换项目：/).click();
  await page
    .locator('.cg-project-picker')
    .getByRole('button')
    .filter({ hasText: workspace.tasks[0].title })
    .click();
  await ready();
  await page.getByRole('button', { name: '开始检查', exact: true }).click();
  let completed = false;
  for (let i = 0; i < 80; i++) {
    const task = await call('task-detail?taskId=' + exampleId);
    if (task.runs.at(-1)?.state === 'succeeded') {
      completed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(completed, 'normal demo run completes');
  const historyRequestsBeforeActivity = detailRequests.filter(
    (query) => new URLSearchParams(query).get('view') === 'history',
  ).length;
  checks.push('正常合成示例检查完成，无付费模型调用');
  await more('调用记录');
  const record = page.locator('.cg-run-record').first();
  await record.locator('summary').first().waitFor();
  assert.equal(
    detailRequests.filter((query) => new URLSearchParams(query).get('view') === 'history').length,
    historyRequestsBeforeActivity,
  );
  assert.equal(
    detailRequests.filter((query) => new URLSearchParams(query).get('view') === 'audit').length,
    0,
  );
  await record.locator('summary').first().click();
  await record.getByText('完整输入、输出与请求记录', { exact: true }).click();
  await record.locator('pre').waitFor();
  assert.match(await record.locator('pre').innerText(), /"steps"/);
  await closeDrawer();
  checks.push('历史抽屉按需读取，只有展开审计才读取单次运行的完整输入输出');

  await page.route('**/api/agent/jobs', (route) =>
    route.fulfill({ status: 503, json: { error: '隔离注入：Agent 轮询失败' } }),
  );
  await page.goto(base + '/agents');
  await page.getByText('隔离注入：Agent 轮询失败', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭错误', exact: true }).click();
  assert.equal(await page.getByText('隔离注入：Agent 轮询失败', { exact: true }).count(), 0);
  checks.push('Agent 错误横幅关闭键按来源清除 pollError');
  assert.deepEqual(pageErrors, []);
  // Chromium logs HTTP 503 resource failures for deliberately rejected requests.
  const unexpectedConsoleErrors = consoleErrors.filter(
    (entry) =>
      !(
        /Failed to load resource: the server responded with a status of 503/.test(entry.text) &&
        /^\/api\/(task-detail|workspace|agent\/jobs)$/.test(new URL(entry.url, base).pathname)
      ),
  );
  assert.deepEqual(unexpectedConsoleErrors, []);
  writeReport('detail-recovery-checks.json', {
    passed: checks.length,
    checks,
    axeChecks,
    pageErrors,
    expectedInjectedHttpErrors: consoleErrors.length,
    unexpectedConsoleErrors,
    screenshotsDirectory: output,
  });
  console.log(`DETAIL_RECOVERY_PASS ${checks.length}`);
} catch (error) {
  writeReport('detail-recovery-failure.json', {
    checks,
    error: error.stack,
    pageErrors,
    consoleErrors,
    serverLog: log,
  });
  throw error;
} finally {
  await browser?.close();
  const exited = new Promise((resolve) => server.once('exit', resolve));
  if (server.exitCode === null) {
    server.kill();
    await exited;
  }
  if (path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(dir, { recursive: true, force: true });
}
