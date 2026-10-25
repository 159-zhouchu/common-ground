import { AppError } from './domain';
import { readBoundedStream } from './bounded-stream';

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
  if (!request.body) return new Uint8Array();
  return readBoundedStream(
    request.body,
    limit,
    () => new AppError('BODY_LIMIT', '请求过大，请缩小文件或文本。', 413),
  );
}
