import { agentStorageReady } from '@/lib/agent-workflow';
import { connectionTests } from '@/lib/store';
import { createHash } from 'node:crypto';
import { checkLocalRequest, boundedBody } from '@/lib/http-guard';
import {
  MAX_JSON_BODY_BYTES,
  MAX_UPLOAD_BODY_BYTES,
  MAX_BLOCK_CHARACTERS,
  MAX_DOCUMENT_CHARACTERS,
  MAX_TASKS,
  MAX_SOURCES,
} from '@/lib/limits';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import { extractDocx } from '@/lib/docx-import';
import {
  readStore,
  runPrimaryConnection,
  readWorkspaceSummary,
  workspaceRevisionTag,
  transact,
  getTask,
  getTaskContent,
  getRunAudit,
  editTask,
  connections,
  publicConnections,
  renameTask,
  archiveTask,
  restoreTask,
} from '@/lib/store';
import {
  AppError,
  uid,
  current,
  appendRevision,
  applyFinding,
  impactFor,
  markdown,
} from '@/lib/domain';
import {
  ConnectionInput,
  saveOneConnection,
  saveSettings,
  deleteConnection,
  copyConnection,
  testConnection,
} from '@/lib/connection-settings';
import { startRun, stopRun } from '@/lib/runner';
import { now } from '@/lib/seed';
import { draftSections, findingStateNames, exportDate, exportDisposition } from '@/lib/text';
import type { Task, Block } from '@/lib/types';
import { ReviewSpecSchema, assessmentRows, scopeNames, verdictNames } from '@/lib/review-scope';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
let cachedSummary: { key: string; payload: string; etag: string } | undefined;
function error(e: unknown) {
  if (e instanceof AppError)
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  if (e instanceof z.ZodError)
    return NextResponse.json(
      {
        error: '输入无效，请检查长度、格式和必填项。',
        code: 'VALIDATION_ERROR',
        fields: e.issues.slice(0, 8).map((i) =>
          i.path
            .map((p) =>
              typeof p === 'number'
                ? p
                : String(p)
                    .replace(/[^A-Za-z0-9_-]/g, '')
                    .slice(0, 40),
            )
            .join('.'),
        ),
      },
      { status: 400 },
    );
  console.error({
    name: e instanceof Error ? e.name : 'Unknown',
    code: (e as NodeJS.ErrnoException)?.code || 'UNEXPECTED',
    location:
      e instanceof Error
        ? e.stack
            ?.split('\n')
            .slice(1, 3)
            .map((line) => line.replace(/\(.*[\\/]/, '('))
        : undefined,
  });
  return NextResponse.json(
    { error: '本机服务暂时无法处理请求，请保留草稿后重试。', code: 'INTERNAL_ERROR' },
    { status: 500 },
  );
}
const idSchema = z.string().min(1).max(100);
const blockSchema = z.object({
  id: idSchema,
  title: z.string().max(200),
  content: z.string().max(MAX_BLOCK_CHARACTERS),
  origin: z.enum(['user', 'ai', 'demo']),
});
export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    checkLocalRequest(req);
    const p = (await params).path.join('/');
    if (p === 'health') {
      const checks = {
        workspace: workspaceRevisionTag,
        connections,
        agents: agentStorageReady,
        connectionTests,
      };
      const components = Object.fromEntries(
        Object.entries(checks).map(([name, check]) => {
          try {
            check();
            return [name, { ready: true }];
          } catch {
            return [name, { ready: false, code: 'STORAGE_UNAVAILABLE' }];
          }
        }),
      );
      const healthy = ['workspace', 'connections', 'agents'].every(
        (name) => components[name].ready,
      );
      return NextResponse.json(
        {
          app: 'common-ground',
          version: '0.1.0',
          storage: 'local-files',
          models: 'user-configured',
          pid: process.pid,
          instance: process.env.CG_INSTANCE_ID || 'local',
          ready: healthy,
          components,
          degraded: !components.connectionTests.ready,
          ...(healthy
            ? {}
            : {
                code: 'STORAGE_UNAVAILABLE',
                error: '本机存储无法读取；原文件未修改，请按恢复说明检查。',
              }),
        },
        { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (p === 'workspace') {
      const summary = req.nextUrl.searchParams.get('view') === 'summary';
      const publicSettings = publicConnections();
      const summaryKey = summary ? workspaceRevisionTag() + JSON.stringify(publicSettings) : '';
      if (summary && cachedSummary?.key === summaryKey) {
        return new Response(
          req.headers.get('if-none-match') === cachedSummary.etag ? null : cachedSummary.payload,
          {
            status: req.headers.get('if-none-match') === cachedSummary.etag ? 304 : 200,
            headers: {
              'Content-Type': 'application/json',
              ETag: cachedSummary.etag,
              'Cache-Control': 'no-cache',
            },
          },
        );
      }
      const store = summary ? readWorkspaceSummary() : readStore();
      const payload = JSON.stringify({
          ...store,
          archivedTasks: (store.archivedTasks || []).map((t) => ({ id: t.id, title: t.title })),
          connections: publicSettings,
        }),
        etag = '"' + createHash('sha256').update(payload).digest('hex') + '"';
      if (summary) cachedSummary = { key: summaryKey, payload, etag };
      if (req.headers.get('if-none-match') === etag)
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, 'Cache-Control': 'no-cache' },
        });
      return new Response(payload, {
        headers: { 'Content-Type': 'application/json', ETag: etag, 'Cache-Control': 'no-cache' },
      });
    }
    if (p === 'task-detail') {
      const id = idSchema.parse(req.nextUrl.searchParams.get('taskId'));
      const view = z
        .enum(['main', 'history', 'audit', 'full'])
        .parse(req.nextUrl.searchParams.get('view') || 'full');
      const content =
        view === 'audit'
          ? getRunAudit(id, idSchema.parse(req.nextUrl.searchParams.get('runId')))
          : view === 'full'
            ? getTask(id)
            : getTaskContent(id, view);
      return NextResponse.json(content, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (p === 'settings')
      return NextResponse.json(publicConnections(), { headers: { 'Cache-Control': 'no-store' } });
    if (p === 'export') {
      const task = getTask(idSchema.parse(req.nextUrl.searchParams.get('taskId')));
      const requested = req.nextUrl.searchParams.get('revision');
      if (requested) {
        if (!task.revisions.some((r) => r.id === requested))
          throw new AppError('NOT_FOUND', '导出版本不存在', 404);
      }
      const rev = task.revisions.find((r) => r.id === (requested || task.currentRevision))!;
      const include = req.nextUrl.searchParams.get('review') === 'true';
      const format = req.nextUrl.searchParams.get('format') || 'md';
      if (format === 'docx') {
        const children = [
          new Paragraph({ text: task.title, heading: HeadingLevel.TITLE }),
          new Paragraph({
            text: `v${rev.number} · ${exportDate(rev.createdAt)}${task.example ? ' · 合成示例' : ''}`,
          }),
        ];
        if (rev.constraint.trim())
          children.push(
            new Paragraph({ text: '任务约束', heading: HeadingLevel.HEADING_1 }),
            new Paragraph(rev.constraint),
          );
        for (const [i, b] of rev.blocks.entries()) {
          children.push(
            new Paragraph({ text: b.title || `第 ${i + 1} 段`, heading: HeadingLevel.HEADING_1 }),
          );
          for (const line of b.content.split('\n'))
            children.push(
              new Paragraph({
                children: [new TextRun({ text: line, font: 'Microsoft YaHei', size: 22 })],
                spacing: { after: 120 },
              }),
            );
        }
        if (include) {
          children.push(
            new Paragraph({ text: '分项审查记录', heading: HeadingLevel.HEADING_1 }),
            new Paragraph('通过仅针对所列标准与当时版本。'),
          );
          for (const { run, criterion, assessment, staleReason } of assessmentRows(task)) {
            children.push(
              new Paragraph({ text: criterion.title, heading: HeadingLevel.HEADING_2 }),
              new Paragraph(`验收标准：${criterion.standard}`),
              new Paragraph(
                `范围：${scopeNames[run.reviewSpec!.mode]}${run.reviewSpec!.focus ? ' · ' + run.reviewSpec!.focus : ''}；v${task.revisions.find((v) => v.id === run.baseRevision)?.number ?? '?'}；${verdictNames[assessment.verdict]}${staleReason ? ' · 待复核' : ''}${run.state === 'partial' ? ' · 部分完成' : ''}${run.mode === 'demo' ? ' · 合成示例' : ''}`,
              ),
              new Paragraph(assessment.reason),
            );
            if (staleReason) children.push(new Paragraph(staleReason));
            for (const e of assessment.evidence)
              children.push(new Paragraph(`依据（${e.blockId || e.sourceId}）：${e.quote}`));
          }
          children.push(
            new Paragraph({ text: '问题与依据记录', heading: HeadingLevel.HEADING_1 }),
            new Paragraph('处理状态截至导出时，正文绑定上述版本。'),
          );
          for (const f of task.findings)
            children.push(
              new Paragraph({ text: f.title, heading: HeadingLevel.HEADING_2 }),
              new Paragraph(
                `${findingStateNames[f.status]}${f.supersededBy ? ' · 已由新审查替代' : f.stale ? ' · 需重审' : ''}：${f.reason}`,
              ),
              new Paragraph(
                `材料：${task.sources.find((s) => s.id === f.sourceId)?.name || '未定位'} v${f.sourceVersion ?? '?'}；原文：${f.quote || '未提供'}。采用建议不等于事实已验证。`,
              ),
            );
        }
        const buf = await Packer.toBuffer(new Document({ sections: [{ children }] }));
        return new Response(new Uint8Array(buf), {
          headers: {
            'Content-Type':
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'Content-Disposition': exportDisposition(task.title, rev.number, 'docx'),
            'Cache-Control': 'no-store',
          },
        });
      }
      return new Response(markdown(task, include, rev.id), {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': exportDisposition(task.title, rev.number, 'md'),
          'Cache-Control': 'no-store',
        },
      });
    }
    throw new AppError('NOT_FOUND', '接口不存在', 404);
  } catch (e) {
    return error(e);
  }
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    checkLocalRequest(req);
    const path = (await params).path.join('/');
    if (path === 'material') {
      const raw = await boundedBody(req, MAX_UPLOAD_BODY_BYTES);
      const contentType = req.headers.get('content-type') || '';
      if (!/^multipart\/form-data\s*;/i.test(contentType))
        throw new AppError('INVALID_MULTIPART', '请使用文件上传表单提交材料。');
      let form: FormData;
      try {
        form = await new Response(raw, { headers: { 'Content-Type': contentType } }).formData();
      } catch {
        throw new AppError('INVALID_MULTIPART', '上传表单格式无效，请重新选择文件上传。');
      }
      const taskId = idSchema.parse(form.get('taskId'));
      const f = form.get('file');
      if (!(f instanceof File) || f.size > 5 * 1024 * 1024)
        throw new AppError('FILE_LIMIT', '请选择不超过 5 MB 的 TXT、Markdown 或 DOCX 文件。');
      const ext = f.name.split('.').pop()?.toLowerCase();
      const buffer = Buffer.from(await f.arrayBuffer());
      let text = '',
        warning = '';
      if (ext === 'docx') {
        const out = await extractDocx(buffer);
        text = out.text;
        warning = '已提取正文与表格文本，不保留分页、版式、批注和图片；复杂表格请对照原件。';
        if (out.hasWarnings) warning += ' 解析器返回提示，请检查提取结果。';
      } else if (ext === 'txt' || ext === 'md') {
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        } catch {
          throw new AppError('ENCODING', '请将文本另存为 UTF-8 后再导入。');
        }
      } else
        throw new AppError('FILE_TYPE', '当前支持 TXT、Markdown 和 DOCX；PDF/扫描件尚未支持。');
      text = text.trim();
      if (!text || text.length > MAX_BLOCK_CHARACTERS)
        throw new AppError('TEXT_LIMIT', '材料不能为空，且每份提取正文需少于 50000 字符。');
      const replacement =
        typeof form.get('replaceId') === 'string' ? String(form.get('replaceId')) : '';
      const source = editTask(taskId, (t) => {
        if (t.sources.length >= MAX_SOURCES && !replacement)
          throw new AppError('SOURCE_LIMIT', '每个项目最多 20 份参考材料。');
        const old = t.sources.find((s) => s.id === replacement);
        if (replacement && !old) throw new AppError('NOT_FOUND', '要替换的材料不存在', 404);
        if (old) {
          old.history ??= [];
          old.history.push({ version: old.version, text: old.text, createdAt: old.createdAt });
          old.version++;
          old.text = text;
          old.name = f.name;
          old.warning = warning;
          old.createdAt = now();
          for (const item of t.findings) if (item.sourceId === old.id) item.stale = true;
          t.impacts = current(t).blocks.map((b) => ({
            id: uid(),
            blockId: b.id,
            title: b.title,
            state: 'unchecked',
            reason: '参考材料已替换；旧引用保留，当前判断需要重新核查。',
            rule: '材料版本变更',
            createdAt: now(),
          }));
          return old;
        }
        const s = {
          id: uid(),
          name: f.name,
          version: 1,
          kind: 'original' as const,
          text,
          createdAt: now(),
          warning,
        };
        t.sources.push(s);
        return s;
      });
      return NextResponse.json(source);
    }
    const raw = await boundedBody(req, MAX_JSON_BODY_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new AppError('INVALID_JSON', '请求格式不是有效的 JSON。');
    }
    const b = z.record(z.string(), z.unknown()).parse(parsed);
    if (path === 'task') {
      const data = z
        .object({
          title: z.string().trim().min(1).max(120),
          goal: z.string().max(4000),
          content: z.string().max(MAX_BLOCK_CHARACTERS),
          constraint: z.string().max(4000),
        })
        .parse(b);
      const createdAt = now(),
        revId = uid();
      const blocks: Block[] = draftSections(data.content).map((section) => ({
        ...section,
        id: uid(),
        origin: 'user',
      }));
      if (blocks.some((b) => b.title.length > 200))
        throw new AppError('TITLE_LIMIT', '段落标题不超过 200 字符。');
      if (blocks.length > 100) throw new AppError('BLOCK_LIMIT', '段落过多，请合并到 100 段以内。');
      const t: Task = {
        id: uid(),
        title: data.title,
        description: '',
        goal: data.goal,
        example: false,
        currentRevision: revId,
        createdAt,
        updatedAt: createdAt,
        revisions: [
          {
            id: revId,
            number: 1,
            title: data.title,
            blocks,
            constraint: data.constraint,
            createdAt,
            reason: '导入用户原稿',
          },
        ],
        sources: [],
        findings: [],
        messages: [],
        runs: [],
        impacts: [],
      };
      transact((s) => {
        if (s.tasks.length >= MAX_TASKS)
          throw new AppError('TASK_LIMIT', '本地工作区最多保存 50 个项目。');
        s.tasks.push(t);
      });
      return NextResponse.json(t);
    }
    if (path === 'settings') {
      return NextResponse.json(saveSettings(b.connections));
    }
    if (path === 'connections/save') return NextResponse.json(saveOneConnection(b.connection));
    if (path === 'connections/delete')
      return NextResponse.json(deleteConnection(idSchema.parse(b.connectionId)));
    if (path === 'connections/copy')
      return NextResponse.json(copyConnection(idSchema.parse(b.connectionId)));
    if (path === 'connections/test') {
      const input = z
        .object({ connection: ConnectionInput, confirmCall: z.literal(true) })
        .parse(b);
      return NextResponse.json(await testConnection(input.connection));
    }
    const taskId = idSchema.parse(b.taskId);
    if (path === 'task/rename')
      return NextResponse.json(
        renameTask(
          taskId,
          z.string().trim().min(1).max(120).parse(b.title),
          idSchema.parse(b.base),
        ),
      );
    if (path === 'task/archive')
      return NextResponse.json(archiveTask(taskId, idSchema.parse(b.base)));
    if (path === 'task/restore') return NextResponse.json(restoreTask(taskId));
    if (path === 'save') {
      const data = z
        .object({
          base: idSchema,
          recoveryFrom: idSchema.optional(),
          blocks: z.array(blockSchema).min(1).max(100),
          constraint: z.string().max(4000),
        })
        .parse(b);
      const result = editTask(taskId, (t) => {
        const prev = current(t);
        const recovered = data.recoveryFrom
          ? t.revisions.find((r) => r.id === data.recoveryFrom)
          : undefined;
        if (data.recoveryFrom && !recovered)
          throw new AppError('NOT_FOUND', '草稿原始版本不存在，原内容仍保留，请核对后重试。', 404);
        if (data.blocks.reduce((a, x) => a + x.content.length, 0) > MAX_DOCUMENT_CHARACTERS)
          throw new AppError('TEXT_LIMIT', '方案正文过长，请缩小范围。');
        if (
          new Set(data.blocks.map((x) => x.id)).size !== data.blocks.length ||
          data.blocks.some(
            (x) =>
              !prev.blocks.some((o) => o.id === x.id) &&
              !recovered?.blocks.some((o) => o.id === x.id) &&
              !z.uuid().safeParse(x.id).success,
          )
        )
          throw new AppError('BLOCK_SCOPE', '段落标识不匹配，请刷新后编辑。');
        const changed = data.blocks
          .filter(
            (x) =>
              prev.blocks.find((o) => o.id === x.id)?.content !== x.content ||
              prev.blocks.find((o) => o.id === x.id)?.title !== x.title,
          )
          .map((x) => x.id);
        const result = appendRevision(
          t,
          data.blocks.map((x) => ({ ...x, origin: changed.includes(x.id) ? 'user' : x.origin })),
          data.constraint,
          recovered ? `旧草稿从 v${recovered.number} 另存为新版本` : '用户编辑与约束更新',
          data.base,
        );
        t.impacts = impactFor(t, prev.constraint, data.constraint, changed);
        return result;
      });
      return NextResponse.json(result);
    }
    if (path === 'patch') {
      const data = z
        .object({
          id: idSchema,
          base: idSchema,
          decision: z.enum(['accepted', 'rejected', 'deferred', 'pending']),
        })
        .parse(b);
      return NextResponse.json(
        editTask(taskId, (t) => {
          if (data.base !== t.currentRevision)
            throw new AppError('REVISION_CONFLICT', '方案已更新，请刷新后再处理建议。', 409);
          if (data.decision === 'accepted') return applyFinding(t, data.id, data.base);
          const f = t.findings.find((f) => f.id === data.id);
          if (!f) throw new AppError('NOT_FOUND', '问题不存在', 404);
          if (f.status === 'accepted')
            throw new AppError('ALREADY_APPLIED', '已采用的修改请通过版本恢复撤回。', 409);
          if (f.supersededBy && ['pending', 'deferred'].includes(data.decision))
            throw new AppError('REVISION_CONFLICT', '此建议已由新审查替代，请查看最新结论。', 409);
          f.status = data.decision;
          return f;
        }),
      );
    }
    if (path === 'restore') {
      const base = idSchema.parse(b.base),
        revision = idSchema.parse(b.revision);
      return NextResponse.json(
        editTask(taskId, (t) => {
          const r = t.revisions.find((r) => r.id === revision);
          if (!r) throw new AppError('NOT_FOUND', '版本不存在', 404);
          const prev = current(t);
          const result = appendRevision(
            t,
            r.blocks,
            r.constraint,
            `从 v${r.number} 恢复为新版本`,
            base,
          );
          t.impacts = impactFor(
            t,
            prev.constraint,
            r.constraint,
            r.blocks
              .filter((x) => prev.blocks.find((o) => o.id === x.id)?.content !== x.content)
              .map((x) => x.id),
          );
          return result;
        }),
      );
    }
    if (path === 'runs') {
      const opts = z
        .object({
          strategy: z.enum(['S0', 'S1', 'S5']),
          selfCheck: z.boolean(),
          mode: z.enum(['demo', 'live']),
          contextMode: z.enum(['continue', 'source_only']),
          slot: z.enum(['a', 'b']).default('a'),
          roleAssignments: z.object({ a: idSchema, b: idSchema.optional() }).optional(),
          compareRole: z.enum(['a', 'b']).default('a'),
          budget: z.number().positive().max(100).nullable(),
          reviewSpec: ReviewSpecSchema.optional(),
          base: idSchema.optional(),
        })
        .parse(b);
      const key = z.uuid().parse(b.idempotencyKey);
      if (opts.reviewSpec && !opts.base)
        throw new AppError('REVIEW_SCOPE', '定向审查需要指定成果版本。');
      return NextResponse.json(startRun(taskId, { ...opts, baseRevision: opts.base }, key));
    }
    if (path === 'stop') {
      stopRun(taskId, idSchema.parse(b.runId));
      return NextResponse.json({ ok: true });
    }
    if (path === 'message') {
      const text = z.string().trim().min(1).max(4000).parse(b.text),
        slot = z.enum(['a', 'b']).default('a').parse(b.slot),
        key = z.uuid().parse(b.idempotencyKey),
        base = idSchema.parse(b.base);
      const receiverId = b.connectionId !== undefined ? idSchema.parse(b.connectionId) : undefined;
      // Resolve legacy slot routing from the original run on replay. Availability
      // belongs to startRun, after its fingerprint check, not before it.
      const selectedId =
        receiverId ??
        runPrimaryConnection(taskId, key) ??
        connections().find((c) => c.slot === slot)?.connectionId ??
        '';
      return NextResponse.json(
        startRun(
          taskId,
          {
            strategy: 'S0',
            selfCheck: false,
            mode: 'live',
            contextMode: 'continue',
            slot,
            roleAssignments: { a: selectedId, b: selectedId },
            budget: null,
            baseRevision: base,
          },
          key,
          text,
        ),
      );
    }
    throw new AppError('NOT_FOUND', '接口不存在', 404);
  } catch (e) {
    return error(e);
  }
}
