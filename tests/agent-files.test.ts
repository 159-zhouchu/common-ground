import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadRequest, requestRoot, scopedFile } from '../scripts/agent-client.mjs';

test('CLI 文件限定请求目录，拦截父目录、敏感配置和符号链接，输出同样受限', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-files-'));
  try {
    const root = path.join(dir, 'request');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'sample.ts'), 'const example = 1;');
    await fs.writeFile(path.join(dir, 'outside.txt'), 'PRIVATE_TEST');
    await fs.writeFile(path.join(root, '.env'), 'TEST_SECRET');
    const request = path.join(root, 'request.json');
    await fs.writeFile(request, JSON.stringify({ files: ['sample.ts'] }));
    assert.equal((await loadRequest(request)).context[0].content, 'const example = 1;');
    const { root: realRoot } = await requestRoot(request);
    for (const name of [
      '../outside.txt',
      path.join(dir, 'outside.txt'),
      '.env',
      '.envsecret',
      '.data/connections.json',
      'secret.pem',
      '.gitconfig',
      'workspace.json',
      'private.crt',
    ]) {
      await assert.rejects(scopedFile(realRoot, name));
      await assert.rejects(scopedFile(realRoot, name, true));
    }
    assert.equal(await scopedFile(realRoot, 'brief.md', true), path.join(realRoot, 'brief.md'));
    await fs.symlink(
      dir,
      path.join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(scopedFile(realRoot, 'escape/outside.txt'));
    await assert.rejects(scopedFile(realRoot, 'escape/brief.md', true));
    await fs.writeFile(request, JSON.stringify({ files: ['../outside.txt'] }));
    await assert.rejects(loadRequest(request));
    await fs.link(path.join(dir, 'outside.txt'), path.join(root, 'linked.txt'));
    await fs.writeFile(request, JSON.stringify({ files: ['linked.txt'] }));
    await assert.rejects(loadRequest(request), /硬链接/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
