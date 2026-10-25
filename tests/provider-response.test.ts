import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { invokeStructured, structuredRequest } from '../lib/models';
import { AppError } from '../lib/domain';
import type { Connection } from '../lib/types';
import { ModelOutputError, MAX_DIAGNOSTIC_BYTES } from '../lib/model-diagnostic';

const limit = 1024 * 1024;
const output = { summary: '本机模拟正文' };
const schema = z.object({ summary: z.string() });
const connection = {
  baseURL: 'http://127.0.0.1:1/v1',
  apiKey: 'SYNTHETIC_KEY_NOT_FOR_OUTPUT',
  model: 'mock',
  protocol: 'responses',
  structured: true,
  inputPrice: 1,
  outputPrice: 1,
} as Connection;
const envelope = (protocol: string) =>
  protocol === 'responses'
    ? {
        status: 'completed',
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
      }
    : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] };

test('供应商响应在解析前限流并校验信封格式，不透传原文', async (t) => {
  let response: Response;
  t.mock.method(globalThis, 'fetch', async () => response);
  const invoke = (protocol: Connection['protocol'] = 'responses') => {
    const c = { ...connection, protocol };
    return invokeStructured(
      c,
      structuredRequest(c, 'test', {}, {}),
      new AbortController().signal,
      schema,
    );
  };
  const fails = async (code: string, protocol: Connection['protocol'] = 'responses') => {
    await assert.rejects(
      invoke(protocol),
      (e: unknown) =>
        e instanceof AppError &&
        e.status === 502 &&
        e.code === code &&
        !e.message.includes(connection.apiKey),
    );
  };
  await t.test('两种协议正常结果与恰好 1 MiB 的信封均接受', async () => {
    for (const protocol of ['responses', 'chat'] as const) {
      const data = { ...envelope(protocol), padding: '' };
      const bytes = Buffer.byteLength(JSON.stringify(data));
      data.padding = 'x'.repeat(limit - bytes);
      const raw = JSON.stringify(data);
      assert.equal(Buffer.byteLength(raw), limit);
      response = new Response(raw);
      assert.deepEqual((await invoke(protocol)).output, output);
    }
  });
  await t.test('无长度声明的分块响应按实际字节拒绝并取消读取', async () => {
    let cancelled = false;
    response = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(limit));
          c.enqueue(new Uint8Array(1));
          c.enqueue(new Uint8Array(1));
          c.close();
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    await fails('PROVIDER_RESPONSE_TOO_LARGE');
    assert.equal(cancelled, true);
  });
  await t.test('声明过大时提前取消；虚报较小也不能绕过实际字节上限', async () => {
    for (const declared of [limit + 1, 1]) {
      response = new Response(new Uint8Array(limit + 1), {
        headers: { 'Content-Length': String(declared) },
      });
      await fails('PROVIDER_RESPONSE_TOO_LARGE');
      assert.equal(response.bodyUsed, true);
    }
  });
  await t.test('畸形 JSON、null、错误内容类型均返回安全的结构化错误', async () => {
    for (const protocol of ['responses', 'chat'] as const) {
      for (const raw of [
        connection.apiKey,
        'null',
        '[]',
        JSON.stringify({ output: {}, choices: 'wrong' }),
        JSON.stringify({
          output: [{ content: [{ type: 'output_text', text: 1 }] }],
          choices: [{ message: { content: {} } }],
        }),
      ]) {
        response = new Response(raw);
        await fails('INVALID_OUTPUT', protocol);
      }
    }
  });
  await t.test('超限失败后释放调用槽位，下一次正常请求仍能完成', async () => {
    response = new Response(JSON.stringify(envelope('responses')));
    assert.deepEqual((await invoke()).output, output);
  });
  await t.test(
    'Chat text parts are joined; invalid paid output retains bounded redacted diagnostics and billing',
    async () => {
      response = Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: [
                { type: 'text', text: '{"summary":' },
                { type: 'text', text: '"parts"}' },
              ],
            },
          },
        ],
      });
      assert.deepEqual((await invoke('chat')).output, { summary: 'parts' });
      response = new Response('null', { headers: { 'x-request-id': 'invalid-envelope' } });
      await assert.rejects(invoke('chat'), (e: unknown) => {
        assert.ok(e instanceof ModelOutputError);
        assert.equal(e.audit.cost, null);
        assert.equal(e.audit.requestId, 'invalid-envelope');
        assert.equal(e.audit.diagnostic?.excerpt, 'null');
        return true;
      });
      for (const content of [connection.apiKey + '中'.repeat(9000), '{"unexpected":true}']) {
        response = Response.json({
          choices: [{ finish_reason: 'stop', message: { content } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
          id: 'paid-request',
        });
        await assert.rejects(invoke('chat'), (e: unknown) => {
          assert.ok(e instanceof ModelOutputError);
          assert.equal(e.audit.cost, 0.00015);
          assert.equal(e.audit.requestId, 'paid-request');
          assert.equal(e.audit.usage?.input, 100);
          assert.ok(Buffer.byteLength(e.audit.diagnostic!.excerpt) <= MAX_DIAGNOSTIC_BYTES);
          assert.ok(!JSON.stringify(e.audit).includes(connection.apiKey));
          return true;
        });
      }
    },
  );
});
