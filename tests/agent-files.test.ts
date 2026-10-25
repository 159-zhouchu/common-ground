import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadRequest, requestRoot, scopedFile } from '../scripts/agent-client.mjs';

// 只有命中 denylist 才会给出这两句文案；文件不存在是 ENOENT，二者必须可区分。
const DENIED = /敏感|私有配置/;
const INVALID = /路径无效/;

async function createFiles(root: string, names: string[]) {
  for (const name of names) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'audit fixture');
  }
}

async function assertDenied(root: string, name: string) {
  await assert.rejects(scopedFile(root, name), DENIED, `读未拦截：${name}`);
  await assert.rejects(scopedFile(root, name, true), DENIED, `输出未拦截：${name}`);
}

async function requestRootOf(root: string) {
  await fs.writeFile(path.join(root, 'request.json'), '{}');
  return requestRoot(path.join(root, 'request.json'));
}

test('CLI 文件限定请求目录，拦截父目录、敏感配置和符号链接，输出同样受限', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-files-'));
  try {
    const root = path.join(dir, 'request');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'sample.ts'), 'const example = 1;');
    await fs.writeFile(path.join(dir, 'outside.txt'), 'PRIVATE_TEST');
    // 先真实创建每个待拒名称；不建文件时 ENOENT 也会 rejects，无法证明规则生效。
    const deniedNames = [
      '.env',
      '.envsecret',
      '.data/connections.json',
      'secret.pem',
      '.gitconfig',
      'workspace.json',
      'private.crt',
      '.netrc',
      '.git-credentials',
      '.docker/config.json',
      '.kube/config',
      '.config/auth.json',
      'auth.json',
      'agent-jobs.json',
      'server-owner.json',
      'server.pid',
      'launcher.lock',
      'state.bak',
      'draft.tmp',
      'server.log',
      '.bash_history',
      '.zsh_history',
      '.yarnrc.yml',
      'secrets.json',
      'token.json',
      'Cookies',
      'Login Data',
    ];
    await createFiles(root, deniedNames);
    // ADS 需要一个真实存在的基底文件；host.txt 本身是允许读取的普通文件。
    await fs.writeFile(path.join(root, 'host.txt'), 'plain fixture');
    const { root: realRoot } = await requestRootOf(root);
    assert.equal(await scopedFile(realRoot, 'sample.ts'), path.join(realRoot, 'sample.ts'));

    for (const name of deniedNames) await assertDenied(realRoot, name);
    for (const name of ['../outside.txt', path.join(dir, 'outside.txt')])
      await assertDenied(realRoot, name);
    await assert.rejects(scopedFile(realRoot, 'host.txt:hidden'), INVALID, 'ADS 未拦截');
    await assert.rejects(scopedFile(realRoot, 'host.txt:hidden', true), INVALID, 'ADS 输出未拦截');

    assert.equal(await scopedFile(realRoot, 'brief.md', true), path.join(realRoot, 'brief.md'));
    await fs.symlink(
      dir,
      path.join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(scopedFile(realRoot, 'escape/outside.txt'));
    await assert.rejects(scopedFile(realRoot, 'escape/brief.md', true));
    await fs.writeFile(path.join(root, 'request.json'), JSON.stringify({ files: ['sample.ts'] }));
    assert.equal(
      (await loadRequest(path.join(root, 'request.json'))).context[0].content,
      'const example = 1;',
    );
    await fs.writeFile(
      path.join(root, 'request.json'),
      JSON.stringify({ files: ['../outside.txt'] }),
    );
    await assert.rejects(loadRequest(path.join(root, 'request.json')));
    await fs.link(path.join(dir, 'outside.txt'), path.join(root, 'linked.txt'));
    await fs.writeFile(path.join(root, 'request.json'), JSON.stringify({ files: ['linked.txt'] }));
    await assert.rejects(loadRequest(path.join(root, 'request.json')), /硬链接/);
    const sensitiveRoot = path.join(dir, '.ssh');
    await fs.mkdir(sensitiveRoot);
    const sensitiveRequest = path.join(sensitiveRoot, 'request.json');
    await fs.writeFile(sensitiveRequest, '{}');
    await assert.rejects(requestRoot(sensitiveRequest), /敏感/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CLI 拦截 P0 敏感凭据路径：先建文件，读与写都必须给出敏感错误', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-p0-'));
  try {
    const root = path.join(dir, 'request');
    await fs.mkdir(root);
    const table = [
      ['.m2/settings.xml', 'Maven 服务器口令'],
      ['.gradle/gradle.properties', 'Gradle 签名与仓库口令'],
      ['.terraform.d/plugin-cache.txt', 'Terraform 凭据目录'],
      ['.terraformrc', 'Terraform CLI 配置'],
      ['credentials.tfrc.json', 'Terraform registry token'],
      ['terraform.tfstate', 'Terraform state'],
      ['prod.tfstate.backup', 'Terraform state 备份'],
      ['.pypirc', 'PyPI token'],
      ['.vault-token', 'Vault token'],
      ['.s3cfg', 's3cmd 密钥'],
      ['.databrickscfg', 'Databricks token'],
      ['.my.cnf', 'MySQL 口令'],
      ['gcloud/credentials.db', 'gcloud 配置目录'],
      ['application_default_credentials.json', 'gcloud 应用默认凭据'],
      ['service-account.json', 'GCP 服务账号私钥'],
      ['service_account.json', 'GCP 服务账号私钥（下划线）'],
      ['service-account-prod.json', 'GCP 服务账号私钥（带后缀）'],
      ['logins.json', 'Firefox 登录库'],
      ['key4.db', 'Firefox 密钥库'],
      ['cert9.db', 'Firefox 证书库'],
      ['cookies.sqlite', 'Firefox cookie 库'],
      ['cookies.sqlite-wal', 'Firefox cookie WAL'],
      ['Local State', 'Chromium Local State'],
      ['Web Data', 'Chromium Web Data'],
      ['id_ecdsa', 'ECDSA 私钥（此前漏列）'],
      ['id_ecdsa.pub', 'ECDSA 公钥'],
      ['id_rsa', 'SSH 私钥回归'],
      ['id_ed25519', 'SSH 私钥回归'],
      ['.ssh/id_rsa', 'SSH 目录回归'],
      ['.gnupg/pubring.kbx', 'GnuPG 目录（4f95d30 新增但无测试）'],
      ['.azure/accessTokens.json', 'Azure 目录（4f95d30 新增但无测试）'],
      ['.aws/credentials', 'AWS 目录回归'],
      ['.kube/config', 'Kubernetes 目录回归'],
      ['.docker/config.json', 'Docker 目录回归'],
      ['.config/gcloud/credentials.db', 'gcloud 子路径回归'],
      ['Cookies', 'Chromium Cookies 回归'],
      ['Login Data', 'Chromium Login Data 回归'],
      ['.npmrc', 'npm token 回归'],
      ['.netrc', 'netrc 回归'],
      ['.git-credentials', 'git 凭据回归'],
      ['.bash_history', 'shell 历史回归'],
      ['.yarnrc.yml', 'yarn 配置回归'],
      ['secrets.json', '通用密钥文件回归'],
      ['token.json', '通用 token 文件回归'],
    ];
    await createFiles(
      root,
      table.map(([name]) => name),
    );
    const { root: realRoot } = await requestRootOf(root);
    for (const [name, why] of table) {
      await assert.rejects(scopedFile(realRoot, name), DENIED, `${why} 读未拦截：${name}`);
      await assert.rejects(scopedFile(realRoot, name, true), DENIED, `${why} 输出未拦截：${name}`);
    }
    // 整条链路：request.json 的 files 指向敏感文件时同样拒绝。
    await fs.writeFile(
      path.join(root, 'p0-request.json'),
      JSON.stringify({ files: ['.m2/settings.xml'] }),
    );
    await assert.rejects(loadRequest(path.join(root, 'p0-request.json')), DENIED);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CLI 不误伤与敏感名相近的普通项目文件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-ok-'));
  try {
    const root = path.join(dir, 'request');
    await fs.mkdir(root);
    const allowed = [
      'normal-settings.txt',
      'sample.ts',
      'local-state.json',
      'local-state.ts',
      'web-data.ts',
      'web_data.ts',
      'web-data.json',
      'my.cnf',
      'gradle.properties',
      'gradle/wrapper/gradle-wrapper.properties',
      'settings.xml',
      'service.ts',
      'account-service.ts',
      'logins.md',
      'gcloud.md',
      'cookies.sqlite.md',
      'cookie-recipe.md',
      'm2/notes.md',
      'terraform.tfstate.md',
      'key4.database',
      '.m2-cache/notes.md',
      '.gradle-notes.md',
    ];
    await createFiles(root, allowed);
    const { root: realRoot } = await requestRootOf(root);
    for (const name of allowed) {
      assert.equal(
        await scopedFile(realRoot, name),
        path.join(realRoot, name),
        `误伤读取：${name}`,
      );
      assert.equal(
        await scopedFile(realRoot, name, true),
        path.join(realRoot, name),
        `误伤输出：${name}`,
      );
    }
    await fs.writeFile(
      path.join(root, 'ok-request.json'),
      JSON.stringify({ files: ['normal-settings.txt', 'local-state.json', 'web-data.ts'] }),
    );
    const loaded = await loadRequest(path.join(root, 'ok-request.json'));
    assert.deepEqual(
      loaded.context.map((item: { name: string }) => item.name),
      ['normal-settings.txt', 'local-state.json', 'web-data.ts'],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
