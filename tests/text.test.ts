import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteLines,
  inlineDiff,
  draftSections,
  firstSentence,
  exportDisposition,
} from '../lib/text';

test('跨行引用按全文偏移命中；CRLF、空行及缺失引用保持原文', () => {
  for (const text of [
    '第一行\n\n金额 60 元\n合计 2310 元\n结束',
    '第一行\r\n金额 60 元\r\n合计 2310 元',
  ]) {
    const quote = text.includes('\r') ? '60 元\r\n合计' : '60 元\n合计';
    const lines = quoteLines(text, quote);
    assert.equal(lines.map((l) => l.before + l.match + l.after).join('\n'), text);
    assert.equal(lines.filter((l) => l.match).length, 2);
    assert.equal(quoteLines(text, '不存在').filter((l) => l.match).length, 0);
  }
});
test('差异对比保留共同文本，支持增删、相同文本和 Unicode 字符', () => {
  for (const [before, after] of [
    ['税费60元', '税费260元'],
    ['删去', ''],
    ['', '新增'],
    ['相同', '相同'],
    ['😀方案', '😁方案'],
  ]) {
    const d = inlineDiff(before, after);
    assert.equal(d.prefix + d.removed + d.suffix, before);
    assert.equal(d.prefix + d.added + d.suffix, after);
  }
  assert.equal(inlineDiff('税费60元', '税费260元').added, '2');
});
test('Markdown 标题归属后续正文，未命名段落不强加标题，代码内井号保持原样', () => {
  assert.deepEqual(draftSections('前言\n\n# 目标\n正文\n\n同一节\n## 预算\n60 元'), [
    { title: '', content: '前言' },
    { title: '目标', content: '正文\n\n同一节' },
    { title: '预算', content: '60 元' },
  ]);
  assert.deepEqual(draftSections('甲\n\n乙'), [
    { title: '', content: '甲' },
    { title: '', content: '乙' },
  ]);
  assert.equal(draftSections('```md\n# 代码示例\n```')[0].content, '```md\n# 代码示例\n```');
});
test('摘要保留原句标点及小数，中文文件名安全编码', () => {
  assert.equal(firstSentence('为什么？下一句。'), '为什么？');
  assert.equal(firstSentence('预算 3.14 元！继续'), '预算 3.14 元！');
  assert.equal(firstSentence(''), '');
  const h = exportDisposition('中文/方案\r\n', 2, 'docx');
  assert.ok(!h.includes('\r'));
  assert.ok(!h.includes('\n'));
  assert.match(h, /filename\*=UTF-8''/);
  assert.match(decodeURIComponent(h), /共桌-中文_方案__-v2.docx/);
});
