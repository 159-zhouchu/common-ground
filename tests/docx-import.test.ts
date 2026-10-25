import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document, Paragraph, Packer } from 'docx';
import { extractDocx } from '../lib/docx-import';
import { AppError } from '../lib/domain';

test('DOCX 在隔离线程解析，正常正文可读，畸形 ZIP 与过大解压内容被拒绝', async () => {
  const good = await Packer.toBuffer(
    new Document({ sections: [{ children: [new Paragraph('示例材料正文')] }] }),
  );
  assert.match((await extractDocx(good)).text, /示例材料正文/);
  await assert.rejects(extractDocx(Buffer.from('not zip')), /DOCX 文件无效/);
  const expanded = await Packer.toBuffer(
    new Document({ sections: [{ children: [new Paragraph('a'.repeat(21 * 1024 * 1024))] }] }),
  );
  assert.ok(expanded.length < 5 * 1024 * 1024);
  await assert.rejects(extractDocx(expanded), /解压内容超过/);
});

test('DOCX 正文超限不导入；并发槽位在成功和失败后均释放', async () => {
  const good = await Packer.toBuffer(
    new Document({ sections: [{ children: [new Paragraph('并发导入正文')] }] }),
  );
  const oversized = await Packer.toBuffer(
    new Document({ sections: [{ children: [new Paragraph('字'.repeat(50001))] }] }),
  );
  await assert.rejects(
    extractDocx(oversized),
    (e) => e instanceof AppError && e.code === 'TEXT_LIMIT',
  );
  const first = extractDocx(good);
  const second = extractDocx(Buffer.from('invalid docx'));
  const results = Promise.allSettled([first, second]);
  await assert.rejects(
    extractDocx(good),
    (e) => e instanceof AppError && e.code === 'DOCX_BUSY' && e.status === 429,
  );
  const completed = await results;
  assert.equal(completed[0].status, 'fulfilled');
  assert.equal(completed[1].status, 'rejected');
  assert.match((await extractDocx(good)).text, /并发导入正文/);
});
