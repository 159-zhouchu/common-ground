import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkLocalRequest, boundedBody } from '@/lib/http-guard';
import { MAX_JSON_BODY_BYTES } from '@/lib/limits';
import { AppError } from '@/lib/domain';
import {
  listAgentJobs,
  getAgentJob,
  startAgentJob,
  stopAgentJob,
  listArchivedAgentJobs,
  archiveAgentJob,
  restoreAgentJob,
} from '@/lib/agent-workflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
const json = (data: unknown) =>
  NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
function failure(error: unknown) {
  if (error instanceof AppError)
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof z.ZodError)
    return NextResponse.json(
      { error: '协作参数无效，请检查任务、角色、预算及上下文长度。', code: 'VALIDATION_ERROR' },
      { status: 400 },
    );
  return NextResponse.json(
    { error: '本机协作服务暂时无法处理请求。', code: 'INTERNAL_ERROR' },
    { status: 500 },
  );
}
export async function GET(req: NextRequest, { params }: Context) {
  try {
    checkLocalRequest(req);
    const p = (await params).path;
    if (p.length === 1 && p[0] === 'jobs') return json(listAgentJobs());
    if (p.length === 1 && p[0] === 'archived') return json(listArchivedAgentJobs());
    if (p.length === 2 && p[0] === 'jobs') return json(getAgentJob(z.uuid().parse(p[1])));
    throw new AppError('NOT_FOUND', '协作接口不存在。', 404);
  } catch (error) {
    return failure(error);
  }
}
export async function POST(req: NextRequest, { params }: Context) {
  try {
    checkLocalRequest(req);
    const p = (await params).path;
    const raw = await boundedBody(req, MAX_JSON_BODY_BYTES);
    let input;
    try {
      input = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new AppError('INVALID_JSON', '请求必须是有效 JSON。');
    }
    if (p.length === 1 && p[0] === 'jobs') return json(startAgentJob(input));
    if (p.length === 3 && p[0] === 'jobs' && p[2] === 'cancel')
      return json(stopAgentJob(z.uuid().parse(p[1])));
    if (p.length === 3 && p[0] === 'jobs' && p[2] === 'archive')
      return json(archiveAgentJob(z.uuid().parse(p[1])));
    if (p.length === 3 && p[0] === 'jobs' && p[2] === 'restore')
      return json(restoreAgentJob(z.uuid().parse(p[1])));
    throw new AppError('NOT_FOUND', '协作接口不存在。', 404);
  } catch (error) {
    return failure(error);
  }
}
