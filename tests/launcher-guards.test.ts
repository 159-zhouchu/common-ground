import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { supportedNode } from '../scripts/check-node.mjs';
import { acquireLauncherLock } from '../scripts/launcher-lock.mjs';

test('Node version gate rejects older releases and runs before install or data creation', () => {
  for (const version of ['18.20.8', '20.19.0', '22.8.9', '22.9.0-rc.1', 'invalid']) {
    assert.equal(supportedNode(version), false, version);
  }
  for (const version of ['22.9.0', '22.10.0', '23.0.0', '24.21.0']) {
    assert.equal(supportedNode(version), true, version);
  }
  const batch = fs.readFileSync('启动共桌.cmd', 'utf8');
  assert.ok(batch.indexOf('node scripts\\check-node.mjs') < batch.indexOf('call npm ci'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-node-gate-'));
  try {
    for (const script of ['check-node', 'start']) {
      const url = new URL(`../scripts/${script}.mjs`, import.meta.url).href;
      const code = `Object.defineProperty(process.versions,'node',{value:'18.20.8'});await import(${JSON.stringify(url)});`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, CG_DATA_DIR: path.join(dir, 'untouched') },
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(child.status, 1, child.stderr);
      assert.match(child.stderr, /18\.20\.8.*22\.9\.0/);
      assert.equal(fs.existsSync(path.join(dir, 'untouched')), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launcher lock recovers old incomplete records, preserves recent/live owners and replacement locks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lock-'));
  const file = path.join(dir, 'launcher.lock');
  function write(raw: string, old = false) {
    fs.writeFileSync(file, raw);
    if (old) {
      const past = new Date(Date.now() - 30000);
      fs.utimesSync(file, past, past);
    }
  }
  try {
    for (const raw of ['', '{', '{}']) {
      write(raw);
      assert.throws(() => acquireLauncherLock(file), /5 秒/);
      assert.equal(fs.readFileSync(file, 'utf8'), raw);
      write(raw, true);
      const release = acquireLauncherLock(file);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
      release();
      assert.equal(fs.existsSync(file), false);
    }
    write(JSON.stringify({ pid: process.pid }), true);
    assert.throws(() => acquireLauncherLock(file), /启动器正在工作/);
    fs.unlinkSync(file);
    const release = acquireLauncherLock(file);
    assert.throws(() => acquireLauncherLock(file), /启动器正在工作/);
    write(JSON.stringify({ pid: process.pid, token: 'replacement' }));
    release();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'replacement');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
