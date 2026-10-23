import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from '../lib/atomic-file';

test('原子写盘短暂冲突重试，永久错误保留旧文件并清理独立临时文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-atomic-')),
    file = path.join(dir, 'data.json'),
    rename = fs.renameSync;
  try {
    writeAtomic(file, { old: true });
    let attempts = 0;
    const temps = new Set<string>();
    let stub = mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      temps.add(String(from));
      if (attempts++ < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      rename(from, to);
    });
    writeAtomic(file, { next: true });
    assert.equal(attempts, 4);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { next: true });
    stub.mock.restore();
    for (const code of ['EACCES', 'EINVAL']) {
      attempts = 0;
      stub = mock.method(fs, 'renameSync', (from: fs.PathLike) => {
        temps.add(String(from));
        attempts++;
        throw Object.assign(new Error('locked'), { code });
      });
      assert.throws(() => writeAtomic(file, { lost: true }));
      assert.equal(attempts, code === 'EACCES' ? 4 : 1);
      stub.mock.restore();
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { next: true });
      assert.deepEqual(fs.readdirSync(dir), ['data.json']);
    }
    assert.equal(temps.size, 3);
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
