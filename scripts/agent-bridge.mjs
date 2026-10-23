import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { localBase, request, waitJob, loadRequest, brief } from './agent-client.mjs';

export async function main(args = process.argv.slice(2)) {
  const [command, value] = args,
    base = localBase();
  if (command === 'connections') {
    console.log(JSON.stringify(await request('settings', undefined, base), null, 2));
    return;
  }
  if (command === 'status' || command === 'cancel') {
    if (!value) throw new Error('请提供协作 ID。');
    console.log(
      JSON.stringify(
        await request(
          'agent/jobs/' + encodeURIComponent(value) + (command === 'cancel' ? '/cancel' : ''),
          command === 'cancel' ? {} : undefined,
          base,
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (command !== 'run' || !value) {
    console.log(
      '用法：node scripts/agent-bridge.mjs connections | run 请求.json [--out 简报.md] | status ID | cancel ID',
    );
    return;
  }
  const outputIndex = args.indexOf('--out'),
    output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && !output) throw new Error('--out 需要文件路径。');
  if (output) {
    try {
      await fs.access(output);
      throw new Error('简报文件已经存在，请使用新文件名；未启动模型调用。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  let job = await request('agent/jobs', await loadRequest(value), base);
  console.error('协作 ID：' + job.id + '；本机模型调用最多 4 次。');
  const deadline = Date.now() + 270000;
  while (job.state === 'running' && Date.now() < deadline) job = await waitJob(job.id, 45000, base);
  if (output) await fs.writeFile(output, brief(job), { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify(job, null, 2));
  // A caller must not interpret partial/needs_input as an executable green light.
  if (job.decision !== 'ready') process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
