import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../scripts/agent-client.mjs';

test('CLI reports non-JSON responses without leaking HTML or raw parser exceptions', async () => {
  const fetch = mock.method(
    globalThis,
    'fetch',
    async () => new Response('<html>PRIVATE_PROXY_ERROR</html>', { status: 502 }),
  );
  try {
    await assert.rejects(request('agent/jobs', undefined, 'http://127.0.0.1:1'), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /非 JSON.*502/);
      assert.ok(!error.message.includes('PRIVATE_PROXY_ERROR'));
      assert.ok(!(error instanceof SyntaxError));
      return true;
    });
  } finally {
    fetch.mock.restore();
  }
});
