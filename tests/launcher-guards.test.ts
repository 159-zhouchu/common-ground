import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { supportedNode } from '../scripts/check-node.mjs';
import { acquireLauncherLock } from '../scripts/launcher-lock.mjs';
import { processIdentity, recordedProcessAlive } from '../scripts/launcher-state.mjs';

test('Darwin process identity parses stable ps output and stays conservative on unreadable identity', () => {
  const execute = ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    assert.equal(command, 'ps');
    assert.deepEqual(args, ['-p', '123', '-o', 'lstart=', '-o', 'comm=']);
    assert.equal(options.env.LC_ALL, 'C');
    return 'Sun Oct 25 08:03:04 2026 /usr/local/bin/node with spaces\n';
  }) as any;
  // Parser/command contract tested on Windows; this is not a macOS runtime test.
  assert.deepEqual(processIdentity(123, 'darwin', execute), {
    birth: 'darwin:Sun Oct 25 08:03:04 2026',
    executable: '/usr/local/bin/node with spaces',
  });
  assert.equal(processIdentity(123, 'darwin', (() => 'unparseable') as any), null);
  assert.equal(
    processIdentity(123, 'darwin', (() => {
      throw new Error('denied');
    }) as any),
    null,
  );
  assert.equal(processIdentity(-1, 'darwin', execute), null);
});

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
    const identity = processIdentity(process.pid);
    if (process.platform === 'win32' || process.platform === 'linux') {
      assert.ok(identity);
      assert.equal(recordedProcessAlive({ pid: process.pid, identity }), true);
      const reused = {
        pid: process.pid,
        identity: { ...identity, birth: identity.birth + '-old' },
      };
      assert.equal(recordedProcessAlive(reused), false);
      write(JSON.stringify(reused), true);
      acquireLauncherLock(file)();
      assert.equal(fs.existsSync(file), false);
    }
    const release = acquireLauncherLock(file);
    assert.throws(() => acquireLauncherLock(file), /启动器正在工作/);
    write(JSON.stringify({ pid: process.pid, token: 'replacement' }));
    release();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'replacement');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
