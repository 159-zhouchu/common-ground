import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsonStore } from '../lib/json-store';

test('locked checkpoint warns without blocking primary commit or changing the previous backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-backup-lock-'));
  try {
    const file = path.join(dir, 'state.json');
    const store = jsonStore(file, () => ({ count: 0 }));
    store.read();
    fs.writeFileSync(file + '.bak', 'previous checkpoint');
    const copy = mock.method(fs, 'copyFileSync', () => {
      throw Object.assign(new Error('locked private path'), { code: 'EBUSY' });
    });
    const warn = mock.method(console, 'warn', () => {});
    store.transact((s) => {
      s.count = 1;
    });
    assert.equal(store.read().count, 1);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).count, 1);
    assert.equal(fs.readFileSync(file + '.bak', 'utf8'), 'previous checkpoint');
    assert.deepEqual(warn.mock.calls[0].arguments, [
      { code: 'CHECKPOINT_FAILED', file: 'state.json', reason: 'EBUSY' },
    ]);
    copy.mock.restore();
    warn.mock.restore();
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-op transactions preserve file timestamp; corrupt primary never overwrites known-good checkpoint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-checkpoint-'));
  try {
    const file = path.join(dir, 'state.json');
    const store = jsonStore(file, () => ({ count: 0 }));
    store.read();
    const first = fs.statSync(file, { bigint: true }).mtimeNs;
    store.transact(() => undefined);
    assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, first);
    store.transact((s) => {
      s.count = 1;
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { count: 0 });
    const backup = fs.readFileSync(file + '.bak', 'utf8');
    fs.writeFileSync(file, '{corrupt');
    assert.throws(() => store.read(), /损坏/);
    assert.throws(
      () =>
        store.transact((s) => {
          s.count++;
        }),
      /损坏/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt');
    assert.equal(fs.readFileSync(file + '.bak', 'utf8'), backup);
    fs.writeFileSync(file, JSON.stringify({ count: 2 }));
    assert.equal(store.read().count, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cached JSON transactions are durable, isolated and do not repeatedly read unchanged files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-json-'));
  const file = path.join(dir, 'state.json');
  try {
    const store = jsonStore(file, () => ({ count: 0, rows: [{ value: 1 }] }));
    store.read();
    const original = fs.readFileSync;
    let reads = 0;
    const spy = mock.method(fs, 'readFileSync', (...args: Parameters<typeof original>) => {
      if (String(args[0]) === file) reads++;
      return Reflect.apply(original, fs, args);
    });
    const copy = store.read();
    copy.rows[0].value = 99;
    const sameFile = jsonStore(file, () => ({ count: -1, rows: [] as { value: number }[] }));
    await Promise.all(
      Array.from({ length: 30 }, async () => {
        await Promise.resolve();
        sameFile.transact((s) => {
          s.count++;
        });
      }),
    );
    assert.equal(store.read().count, 30);
    assert.equal(store.read().rows[0].value, 1);
    assert.equal(reads, 0);
    spy.mock.restore();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).count, 30);
    const result = store.transact((s) => s.rows);
    result[0].value = 100;
    assert.equal(store.read().rows[0].value, 1);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(
      () =>
        store.transact((s) => {
          s.count++;
          throw new Error('rollback');
        }),
      /rollback/,
    );
    assert.throws(
      () =>
        store.transact(async (s) => {
          s.count = 50;
        }),
      /同步/,
    );
    assert.throws(
      () =>
        store.transact(() =>
          store.transact((s) => {
            s.count++;
          }),
        ),
      /嵌套/,
    );
    const failure = mock.method(fs, 'renameSync', () => {
      throw Object.assign(new Error('disk failed'), { code: 'EINVAL' });
    });
    assert.throws(
      () =>
        store.transact((s) => {
          s.count = 80;
        }),
      /disk failed/,
    );
    failure.mock.restore();
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(store.read().count, 30);
    fs.writeFileSync(file, JSON.stringify({ count: 12345, rows: [] }));
    assert.equal(store.read().count, 12345);
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restart recovery commits interrupted state only once per file in a process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-recover-'));
  const file = path.join(dir, 'state.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ state: 'running' }));
    let recoveries = 0;
    const recover = (s: { state: string }) => {
      recoveries++;
      s.state = 'interrupted';
      return true;
    };
    const store = jsonStore(file, () => ({ state: 'idle' }), recover);
    assert.equal(store.read().state, 'interrupted');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'interrupted');
    store.transact((s) => {
      s.state = 'running';
    });
    assert.equal(jsonStore(file, () => ({ state: 'idle' }), recover).read().state, 'running');
    assert.equal(recoveries, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
