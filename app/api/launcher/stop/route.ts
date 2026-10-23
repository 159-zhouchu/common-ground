import { timingSafeEqual } from 'node:crypto';
import { checkLocalRequest } from '@/lib/http-guard';
import { AppError } from '@/lib/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Only launcher-owned instances have this credential. Never return it via an API.
export async function POST(request: Request) {
  try {
    checkLocalRequest(request);
  } catch (error) {
    if (error instanceof AppError)
      return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
  const expected = process.env.CG_LAUNCHER_TOKEN || '',
    supplied = request.headers.get('x-cg-launcher-token') || '';
  if (
    !/^[a-f0-9]{64}$/.test(expected) ||
    !/^[a-f0-9]{64}$/.test(supplied) ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)) ||
    request.headers.get('x-cg-instance') !== process.env.CG_INSTANCE_ID ||
    request.headers.get('x-cg-pid') !== String(process.pid)
  ) {
    return Response.json({ error: '停止凭据与当前启动实例不匹配。' }, { status: 403 });
  }
  // Give the response time to flush, then use Next's graceful shutdown handler.
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 250).unref();
  return Response.json(
    { stopping: true },
    { status: 202, headers: { 'Cache-Control': 'no-store', Connection: 'close' } },
  );
}
