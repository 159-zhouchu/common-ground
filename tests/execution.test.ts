import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  limitedRequest,
  lockTask,
  taskInFlight,
  lockConnections,
  connectionInUse,
} from '../lib/execution';

test('queued gate preserves FIFO, cancellation releases no extra permit, failures do not leak capacity', async () => {
  let active = 0,
    peak = 0;
  const entered: number[] = [];
  const release: (() => void)[] = [];
  const run = (i: number, signal = new AbortController().signal) =>
    limitedRequest(signal, async () => {
      active++;
      peak = Math.max(peak, active);
      entered.push(i);
      try {
        await new Promise<void>((resolve) => {
          release[i] = resolve;
        });
      } finally {
        active--;
      }
      if (i === 3) throw new Error('expected');
      return i;
    });
  const cancelled = new AbortController();
  const promises = [run(0), run(1), run(2, cancelled.signal), run(3), run(4), run(5)];
  const results = Promise.allSettled(promises);
  cancelled.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, [0, 1]);
  release[1]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, [0, 1, 3]);
  release[0]();
  await new Promise((resolve) => setImmediate(resolve));
  release[3]();
  await new Promise((resolve) => setImmediate(resolve));
  release[4]();
  release[5]();
  const settled = await results;
  assert.equal(settled[2].status, 'rejected');
  assert.equal(settled[3].status, 'rejected');
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(entered, [0, 1, 3, 4, 5]);
  await assert.rejects(limitedRequest(AbortSignal.abort(), async () => 1));
  assert.deepEqual(
    await Promise.all(
      [0, 1, 2].map((i) => limitedRequest(new AbortController().signal, async () => i)),
    ),
    [0, 1, 2],
  );
});

test('task and connection lock releases are idempotent while other holders remain', () => {
  for (const [lock, inUse] of [
    [lockTask, taskInFlight],
    [(id: string) => lockConnections([id, id]), connectionInUse],
  ] as const) {
    const releaseA = lock('isolated-lock'),
      releaseB = lock('isolated-lock');
    releaseA();
    releaseA();
    assert.equal(inUse('isolated-lock'), true);
    releaseB();
    releaseB();
    assert.equal(inUse('isolated-lock'), false);
  }
});
