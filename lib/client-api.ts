export class ClientError extends Error {
  constructor(
    message: string,
    public code?: string,
    public status?: number,
  ) {
    super(message);
  }
}

export async function localFetch(url: string, init: RequestInit = {}, timeoutMs = 20000) {
  try {
    return await fetch(url, {
      cache: 'no-store',
      ...init,
      signal: AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ClientError('无法连接本机服务或请求超时，请确认共桌仍在运行后重试。');
  }
}
export async function responseJSON(response: Response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ClientError(
      `本机服务返回了无法读取的响应（HTTP ${response.status}）。`,
      undefined,
      response.status,
    );
  }
  if (!response.ok || data === null || typeof data !== 'object')
    throw new ClientError(
      typeof data?.error === 'string' ? data.error : `本机请求失败（HTTP ${response.status}）。`,
      data?.code,
      response.status,
    );
  return data;
}
export async function api(route: string, body?: unknown, signal?: AbortSignal) {
  return responseJSON(
    await localFetch(
      '/api/' + route,
      {
        signal,
        ...(body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }),
      },
      route === 'connections/test' ? 45000 : 20000,
    ),
  );
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
