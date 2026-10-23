import type { Finding } from './types';

export const findingStateNames: Record<Finding['status'], string> = {
  pending: '待处理',
  deferred: '已暂缓',
  accepted: '已接受',
  rejected: '已拒绝',
};
export function exportDate(value: string) {
  return (
    new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) +
    '（北京时间）'
  );
}
export function firstSentence(value: string) {
  return value.trim().match(/^[^。！？\n]+[。！？]?/)?.[0] || value.trim();
}

// Offsets refer to the complete original text, including newline characters.
export function quoteLines(text: string, quote?: string) {
  const start = quote ? text.indexOf(quote) : -1,
    end = start + (quote?.length ?? 0);
  let offset = 0;
  return text.split('\n').map((line) => {
    const from = Math.max(0, start - offset),
      to = Math.min(line.length, end - offset),
      hit = start >= 0 && to > from;
    offset += line.length + 1;
    return hit
      ? { before: line.slice(0, from), match: line.slice(from, to), after: line.slice(to) }
      : { before: line, match: '', after: '' };
  });
}
export function inlineDiff(before: string, after: string) {
  const a = Array.from(before),
    b = Array.from(after);
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return {
    prefix: a.slice(0, start).join(''),
    removed: a.slice(start, a.length - end).join(''),
    added: b.slice(start, b.length - end).join(''),
    suffix: end ? a.slice(-end).join('') : '',
  };
}
export function draftSections(text: string) {
  const result: { title: string; content: string }[] = [];
  let title = '',
    lines: string[] = [],
    fence = '';
  const flush = () => {
    const content = lines.join('\n').trim();
    if (title || content) result.push({ title, content });
    title = '';
    lines = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = '';
      lines.push(line);
      continue;
    }
    const heading = !fence && line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      title = heading[1];
    } else if (!fence && !line.trim() && !title) flush();
    else lines.push(line);
  }
  flush();
  return result.length ? result : [{ title: '', content: '' }];
}
export function exportDisposition(title: string, version: number, extension: 'md' | 'docx') {
  const safe =
    Array.from(
      title
        .toWellFormed()
        .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
        .trim(),
    )
      .slice(0, 100)
      .join('') || '方案';
  const filename = `共桌-${safe}-v${version}.${extension}`;
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="common-ground-v${version}.${extension}"; filename*=UTF-8''${encoded}`;
}
