import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLocalRequest, boundedBody } from '../lib/http-guard';
import { seed, exampleReview } from '../lib/seed';
import { normalizeReview, current, applyFinding } from '../lib/domain';
import { filteredFindings } from '../lib/presentation';
import { exportDisposition } from '../lib/text';
test('本机 Host 与 Origin 白名单同时保护读写；无 Origin 的本机 CLI 可用', () => {
  for (const host of ['127.0.0.1:3210', 'localhost:3210', '[::1]:3210']) {
    assert.doesNotThrow(() =>
      checkLocalRequest(new Request('http://localhost', { headers: { host } })),
    );
    assert.doesNotThrow(() =>
      checkLocalRequest(
        new Request('http://localhost', { headers: { host, origin: 'http://' + host } }),
      ),
    );
  }
  for (const headers of [
    { host: 'evil.example' },
    { host: 'evil.example', origin: 'http://evil.example' },
    { host: 'localhost:3210', origin: 'null' },
    { host: 'localhost:3210', origin: 'https://localhost:3210' },
    { host: 'localhost:3210', origin: 'http://localhost:3211' },
    { host: 'localhost:3210', 'sec-fetch-site': 'cross-site' },
  ])
    assert.throws(
      () =>
        checkLocalRequest(
          new Request('http://localhost', {
            headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)),
          }),
        ),
      (e: unknown) => (e as { status: number }).status === 403,
    );
});
test('流式请求不依赖 Content-Length；超限取消读取，正常正文逐字保留', async () => {
  let cancelled = false;
  const req = new Request('http://localhost', {
    method: 'POST',
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(4));
        c.enqueue(new Uint8Array(5));
      },
      cancel() {
        cancelled = true;
      },
    }),
    duplex: 'half',
  } as RequestInit);
  await assert.rejects(
    boundedBody(req, 8),
    (e: unknown) => (e as { status: number }).status === 413,
  );
  assert.ok(cancelled);
  assert.equal(
    new TextDecoder().decode(
      await boundedBody(new Request('http://localhost', { method: 'POST', body: '中文' }), 6),
    ),
    '中文',
  );
});
test('采纳单段或全稿超限时保持版本与决定完全不变', () => {
  for (const total of [false, true]) {
    const t = seed().tasks[0];
    t.findings = normalizeReview(t, exampleReview(), 'r', t.currentRevision);
    const f = t.findings[0],
      r = current(t),
      target = r.blocks.find((b) => b.id === f.blockId)!;
    target.content = f.before + 'x'.repeat((total ? 49000 : 50000) - f.before.length);
    if (total) {
      r.blocks[0].content = 'y'.repeat(50000);
      r.blocks[2].content = 'z'.repeat(50000);
    }
    f.after = f.before + 'a'.repeat(2000);
    const before = JSON.stringify(t);
    assert.throws(
      () => applyFinding(t, f.id, t.currentRevision),
      (e: unknown) => (e as { code: string }).code === 'PATCH_LIMIT',
    );
    assert.equal(JSON.stringify(t), before);
  }
});
test('失效建议单列需重查，处理历史保留；emoji 文件名不切断代理对', () => {
  const t = seed().tasks[0],
    f = normalizeReview(t, exampleReview(), 'r', t.currentRevision);
  f[0].stale = true;
  f[1].status = 'accepted';
  assert.deepEqual(
    filteredFindings(f, 'pending').map((x) => x.id),
    [f[2].id],
  );
  assert.deepEqual(
    filteredFindings(f, 'stale').map((x) => x.id),
    [f[0].id],
  );
  assert.equal(filteredFindings(f, 'all').length, 3);
  assert.ok(decodeURIComponent(exportDisposition('A'.repeat(99) + '😀', 1, 'md')).includes('😀'));
});
