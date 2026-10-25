import { parentPort, workerData } from 'node:worker_threads';
import yauzl from 'yauzl';
import mammoth from 'mammoth';

const MAX_EXPANDED_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 1000;
function limit() {
  return Object.assign(new Error('DOCX 解压内容超过 20 MB 或 1000 个条目，请缩小文件。'), {
    code: 'DOCX_LIMIT',
  });
}
function validateZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      let expanded = 0,
        count = 0,
        failed = false;
      const fail = (e) => {
        if (failed) return;
        failed = true;
        zip.close();
        reject(e);
      };
      zip.on('error', fail);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        if (++count > MAX_ENTRIES || expanded + entry.uncompressedSize > MAX_EXPANDED_BYTES)
          return fail(limit());
        if (entry.generalPurposeBitFlag & 1) return fail(new Error('Encrypted ZIP'));
        if (entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e) return fail(e);
          stream.on('error', fail);
          stream.on('data', (chunk) => {
            expanded += chunk.length;
            if (expanded > MAX_EXPANDED_BYTES) {
              stream.destroy();
              fail(limit());
            }
          });
          stream.on('end', () => {
            if (!failed) zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

try {
  const buffer = Buffer.from(workerData.buffer);
  await validateZip(buffer);
  const result = await mammoth.extractRawText({ buffer });
  if (result.value.length > 50000)
    throw Object.assign(new Error('DOCX 提取正文超过 50000 字符，请缩小文件。'), {
      code: 'TEXT_LIMIT',
    });
  parentPort.postMessage({ text: result.value, hasWarnings: result.messages.length > 0 });
} catch (error) {
  parentPort.postMessage({
    error: ['DOCX_LIMIT', 'TEXT_LIMIT'].includes(error.code)
      ? error.message
      : 'DOCX 文件无效、已加密或无法提取正文。',
    code: ['DOCX_LIMIT', 'TEXT_LIMIT'].includes(error.code) ? error.code : 'DOCX_INVALID',
  });
} finally {
  parentPort.close();
}
