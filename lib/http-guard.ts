import { AppError } from './domain';

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
export function checkLocalRequest(request: Request) {
  const host = request.headers.get('host');
  let url: URL;
  try {
    if (!host || /[\s/@?#\\]/.test(host)) throw new Error();
    url = new URL('http://' + host);
    if (!localHosts.has(url.hostname)) throw new Error();
  } catch {
    throw new AppError('HOST_DENIED', '仅接受本机地址请求。', 403);
  }
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      const o = new URL(origin);
      if (
        o.protocol !== new URL(request.url).protocol ||
        o.host !== url.host ||
        !localHosts.has(o.hostname)
      )
        throw new Error();
    } catch {
      throw new AppError('ORIGIN_DENIED', '请求来源与本机网站不一致。', 403);
    }
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    throw new AppError('ORIGIN_DENIED', '不接受跨站请求。', 403);
}
export async function boundedBody(request: Request, limit: number) {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > limit)
    throw new AppError('BODY_LIMIT', '请求过大，请缩小文件或文本。', 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new AppError('BODY_LIMIT', '请求过大，请缩小文件或文本。', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
