import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedStream } from '../lib/bounded-stream';

test('bounded reader accepts empty and exact limits without retaining tiny chunks', async () => {
  for (const size of [0, 3, 1024 * 1024]) {
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i++ < size) controller.enqueue(new Uint8Array([65]));
        else controller.close();
      },
    });
    const output = await readBoundedStream(stream, 1024 * 1024, () => new Error('limit'));
    assert.equal(output.byteLength, size);
    assert.ok(output.every((x) => x === 65));
    assert.ok(output.buffer.byteLength <= 1024 * 1024);
    assert.ok(size === 0 || output.buffer.byteLength >= size);
    assert.equal(output.buffer.byteLength, size);
    assert.equal(stream.locked, false);
  }
});

test('bounded reader cancels on overflow and releases lock on read/cancel failures', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(3));
    },
    cancel() {
      cancelled = true;
      throw new Error('cancel failed');
    },
  });
  await assert.rejects(
    readBoundedStream(stream, 2, () => new Error('limit')),
    /limit/,
  );
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
  const broken = new ReadableStream<Uint8Array>({
    pull() {
      throw new Error('read failed');
    },
  });
  await assert.rejects(
    readBoundedStream(broken, 2, () => new Error('limit')),
    /read failed/,
  );
  assert.equal(broken.locked, false);
});
