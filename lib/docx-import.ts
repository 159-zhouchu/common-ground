import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { AppError } from './domain';

// Shared by route reloads in this Node process; no queue holding upload buffers.
const state = globalThis as typeof globalThis & { cgDocxImports?: { active: number } };
const imports = (state.cgDocxImports ??= { active: 0 });

export function extractDocx(buffer: Buffer): Promise<{ text: string; hasWarnings: boolean }> {
  if (imports.active >= 2)
    return Promise.reject(new AppError('DOCX_BUSY', '已有两份 DOCX 正在解析，请稍后再试。', 429));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      // Launch scripts run from the project root. Keep this path external to
      // the Next bundle, where the parser's dependencies remain installed.
      worker = new Worker(path.join(process.cwd(), 'scripts', 'docx-worker.mjs'), {
        workerData: { buffer },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
      });
    } catch {
      reject(new AppError('DOCX_UNAVAILABLE', '暂时无法启动 DOCX 解析，请稍后重试。', 503));
      return;
    }
    imports.active++;
    let settled = false;
    const finish = (error?: AppError, result?: { text: string; hasWarnings: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker
        .terminate()
        .catch(() => {})
        .finally(() => {
          imports.active--;
          if (error) reject(error);
          else resolve(result!);
        });
    };
    const timer = setTimeout(
      () => finish(new AppError('DOCX_TIMEOUT', 'DOCX 解析超过 8 秒，请缩小或简化文件。')),
      8000,
    );
    worker.once('message', (result) => {
      finish(result.error ? new AppError(result.code, result.error) : undefined, result);
    });
    worker.once('error', () =>
      finish(new AppError('DOCX_INVALID', 'DOCX 解析失败或超过内存限制，请简化文件。')),
    );
    worker.once('exit', () => {
      if (!settled) finish(new AppError('DOCX_INVALID', 'DOCX 解析意外中断。'));
    });
  });
}
