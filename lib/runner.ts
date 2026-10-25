import { createHash } from 'node:crypto';
import type { Task, Run, RunOptions, Review, Connection, ConnectionSnapshot } from './types';
import { AppError, current, manifest, normalizeReview, plan, uid } from './domain';
import { connections, editTask, getTask } from './store';
import { exampleReview, now } from './seed';
import { invoke, modelRequest, reserveCost } from './models';
import { lockConnections, lockTask } from './execution';
import { documentInputBudget } from './document-input';
import {
  ReviewSpecSchema,
  reviewSpecError,
  reviewBlockAllowed,
  checkedAssessments,
  scopedOutputError,
  supersedeScopedFindings,
} from './review-scope';
import { MAX_MODEL_OUTPUT_BYTES } from './limits';
const globalRun = globalThis as typeof globalThis & {
  cgControllers?: Map<string, AbortController>;
};
const controllers = (globalRun.cgControllers ??= new Map());
function alive(task: Task, id: string) {
  return task.runs.find((r) => r.id === id)?.state === 'running';
}
export function startRun(
  taskId: string,
  opts: RunOptions,
  idempotencyKey: string,
  discussionQuestion?: string,
) {
  opts = {
    ...opts,
    slot: opts.strategy === 'S0' ? opts.slot : 'a',
    selfCheck: opts.strategy === 'S0' && opts.selfCheck,
    contextMode: opts.mode === 'demo' ? 'continue' : opts.contextMode,
  };
  if (opts.reviewSpec) opts.reviewSpec = ReviewSpecSchema.parse(opts.reviewSpec);
  const requestFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        strategy: opts.strategy,
        selfCheck: opts.selfCheck,
        mode: opts.mode,
        contextMode: opts.contextMode,
        slot: opts.slot,
        compareRole: opts.compareRole || 'a',
        budget: opts.budget,
        baseRevision: opts.baseRevision ?? null,
        roles: opts.roleAssignments
          ? [opts.roleAssignments.a, opts.roleAssignments.b ?? null]
          : null,
        reviewSpec: opts.reviewSpec ?? null,
        discussionQuestion: discussionQuestion ?? null,
      }),
    )
    .digest('hex');
  const task = getTask(taskId);
  const duplicate = task.runs.find((r) => r.id === idempotencyKey);
  if (duplicate) {
    if (duplicate.requestFingerprint !== requestFingerprint)
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        '该请求标识已用于其他参数或旧版记录，请使用新的请求标识。',
        409,
      );
    return duplicate;
  }
  if (opts.baseRevision && opts.baseRevision !== task.currentRevision)
    throw new AppError('REVISION_CONFLICT', '方案已更新，请刷新后按当前版本检查。', 409);
  if (opts.reviewSpec) {
    const error = reviewSpecError(opts.reviewSpec, task);
    if (error) throw new AppError('REVIEW_SCOPE', error);
    if (opts.contextMode !== 'continue' || discussionQuestion)
      throw new AppError('REVIEW_SCOPE', '定向审查需要当前方案；讨论与原材料重答请单独运行。');
  }
  if (task.runs.some((r) => r.state === 'running'))
    throw new AppError('RUN_ACTIVE', '已有运行，请先停止再启动新策略。', 409);
  if (opts.mode === 'demo' && !task.example)
    throw new AppError('DEMO_ONLY', '演示运行仅用于合成示例项目；自己的材料请连接真实模型。');
  if (opts.strategy === 'S5' && opts.contextMode === 'source_only')
    throw new AppError('CONTEXT_MODE', '核对当前方案需要读取成果；原材料重答请选择独立多视角。');
  if (opts.strategy === 'S5' && !task.sources.length)
    throw new AppError('SOURCE_REQUIRED', '请先导入至少一份参考材料。');
  const steps = plan(opts),
    all = connections();
  const mapping = opts.roleAssignments ?? {
    a: all.find((c) => c.slot === 'a')?.connectionId || '',
    b: all.find((c) => c.slot === 'b')?.connectionId || '',
  };
  const configs: Partial<Record<'a' | 'b', Connection>> = {};
  if (opts.mode === 'live')
    for (const step of steps) {
      const role = step.slot as 'a' | 'b';
      const c = all.find((c) => c.connectionId === mapping[role]);
      if (!c || !c.enabled || !c.apiKey || !c.model)
        throw new AppError(
          'MODEL_UNAVAILABLE',
          `角色 ${role.toUpperCase()} 未选择可用连接，或连接已停用／删除，请重新选择。`,
        );
      configs[role] = structuredClone(c);
      step.connectionId = c.connectionId;
      step.connectionSnapshot = connectionSnapshot(c);
    }
  // getTask returns a detached snapshot: this question is visible to preflight
  // and inference only. Persist the user/assistant pair after a usable result.
  if (discussionQuestion)
    task.messages.push({
      id: uid(),
      actor: 'user',
      content: discussionQuestion,
      createdAt: now(),
      runId: idempotencyKey,
    });
  if (opts.mode === 'live') {
    const input = documentInputBudget(task, opts);
    if (input.exceeded)
      throw new AppError(
        'INPUT_TOO_LARGE',
        steps.length > 1
          ? '多步检查的初始输入超过 80 KB，请缩小材料或讨论；后续模型结果需要预留空间。'
          : '本次输入超过 100 KB，请缩小材料或讨论。',
      );
    for (const step of steps)
      modelRequest(
        configs[step.slot as 'a' | 'b']!,
        manifest(
          task,
          step.duty === 'compare' ? 'continue' : opts.contextMode,
          undefined,
          opts.reviewSpec,
        ),
        step.duty,
      );
  }
  const run: Run = {
    requestFingerprint,
    reviewSpec: opts.reviewSpec,
    reviewBasis: opts.reviewSpec
      ? { goal: task.goal, sources: task.sources.map(({ id, version }) => ({ id, version })) }
      : undefined,
    discussionQuestion,
    roleAssignments: opts.mode === 'live' ? mapping : undefined,
    connectionSnapshots: Object.values(configs).map((c) => connectionSnapshot(c!)),
    compareRole: opts.compareRole || 'a',
    id: idempotencyKey,
    strategy: opts.strategy,
    selfCheck: opts.selfCheck,
    mode: opts.mode,
    contextMode: opts.contextMode,
    baseRevision: task.currentRevision,
    branch: opts.contextMode === 'source_only' ? '原材料新分支' : '当前讨论',
    state: 'running',
    steps,
    createdAt: now(),
    summary: '',
    limit: steps.length,
    findings: [],
    slot: opts.slot,
    deadline: Date.now() + 180000,
    budget: opts.budget,
  };
  editTask(taskId, (t) => {
    t.runs.push(run);
    return run;
  });
  const controllerKey = JSON.stringify([taskId, run.id]);
  const controller = new AbortController();
  controllers.set(controllerKey, controller);
  const release = lockConnections(Object.values(configs).map((c) => c!.connectionId)),
    releaseTask = lockTask(taskId);
  void execute(structuredClone(task), run, controller, configs)
    .catch(() => {
      editTask(taskId, (t) => {
        const r = t.runs.find((r) => r.id === run.id)!;
        if (r.state === 'running') {
          r.state = 'failed';
          r.error = '运行意外中断，请查看调用记录并手动重试。';
          r.endedAt = now();
        }
      });
    })
    .finally(() => {
      controllers.delete(controllerKey);
      release();
      releaseTask();
    });
  return run;
}
function connectionSnapshot(c: Connection): ConnectionSnapshot {
  const {
    connectionId,
    label,
    model,
    protocol,
    baseURL,
    updatedAt,
    structured,
    inputPrice,
    outputPrice,
  } = c;
  return {
    connectionId,
    label,
    model,
    protocol,
    baseURL,
    updatedAt,
    structured,
    inputPrice,
    outputPrice,
  };
}
async function execute(
  snapshot: Task,
  run: Run,
  controller: AbortController,
  configs: Partial<Record<'a' | 'b', Connection>>,
) {
  let reserved = 0;
  const perform = async (index: number, prior: Review[] = []) => {
    if (!alive(getTask(snapshot.id), run.id)) return null;
    const step = run.steps[index];
    const c = configs[step.slot as 'a' | 'b'];
    const mode = step.duty === 'compare' ? 'continue' : run.contextMode;
    const m = manifest(snapshot, mode, undefined, run.reviewSpec);
    if (prior.length) {
      m.priorOutputs = prior;
      m.hash = createHash('sha256')
        .update(JSON.stringify({ ...m, hash: undefined }))
        .digest('hex');
    }
    try {
      const prepared = run.mode === 'live' ? modelRequest(c!, m, step.duty) : null;
      editTask(snapshot.id, (t) => {
        const s = t.runs.find((r) => r.id === run.id)!.steps[index];
        s.status = 'running';
        s.startedAt = now();
        s.manifest = m;
        s.model = c?.model || '预置示例';
        s.sent = false;
      });
      if (Date.now() > run.deadline) throw new AppError('TIMEOUT', '达到本次运行的三分钟时限。');
      let result;
      if (run.mode === 'demo') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 650);
          controller.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        const review = exampleReview();
        if (run.reviewSpec) {
          review.findings = review.findings.filter((f) =>
            reviewBlockAllowed(run.reviewSpec!, f.blockId),
          );
          review.assessments = run.reviewSpec.criteria.map((c) => ({
            criterionId: c.id,
            verdict: 'insufficient',
            reason: '合成示例仅演示预置问题，不判断自定义验收标准。',
            evidence: [],
          }));
        }
        review.findings = review.findings.filter((f) =>
          current(snapshot)
            .blocks.find((b) => b.id === f.blockId)
            ?.content.includes(f.before),
        );
        if (review.findings.length)
          review.summary = `当前方案仍包含 ${review.findings.length} 处预置示例问题。示例检查器只覆盖这三处预设问题，不评估其他内容或新增约束。`;
        if (!review.findings.length)
          review.summary =
            '示例中预置的三处问题已不在当前成果中。本次没有新增演示问题；这不是对全文正确性的认证。';
        result = {
          review,
          usage: { input: 0, output: 0, raw: { demo: true } },
          cost: 0,
          requestId: undefined,
        };
      } else {
        const req = prepared!;
        const reserve = reserveCost(c!, req.upperInput, req.maxOutput);
        if (run.budget !== null && (reserve === null || reserved + reserve > run.budget))
          throw new AppError(
            'BUDGET_EXCEEDED',
            reserve === null
              ? '设置了金额上限，但模型价格未知；未发送本次请求。'
              : '保守预留金额超过预算；未发送本次请求。',
          );
        if (reserve !== null) reserved += reserve;
        editTask(snapshot.id, (t) => {
          const step = t.runs.find((r) => r.id === run.id)!.steps[index];
          step.inputHash = req.inputHash;
        });
        const timeout = AbortSignal.timeout(
          Math.max(1, Math.min(90000, run.deadline - Date.now())),
        );
        result = await invoke(c!, req, AbortSignal.any([controller.signal, timeout]), () => {
          editTask(snapshot.id, (t) => {
            t.runs.find((r) => r.id === run.id)!.steps[index].sent = true;
          });
        });
        // Unreported usage keeps its reservation; concurrent calls retain their own reservations.
        if (reserve !== null && result.cost !== null) reserved += result.cost - reserve;
      }
      editTask(snapshot.id, (t) => {
        const r = t.runs.find((r) => r.id === run.id)!;
        const s = r.steps[index];
        s.endedAt = now();
        s.usage = result.usage;
        s.cost = result.cost;
        s.requestId = result.requestId;
      });
      if (run.reviewSpec) {
        const error = run.mode === 'live' ? scopedOutputError(run.reviewSpec, result.review) : '';
        if (error) throw new AppError('REVIEW_SCOPE', error);
        result.review.assessments = checkedAssessments(snapshot, run.reviewSpec, result.review);
        if (run.mode === 'live')
          result.review.findings = result.review.findings.filter((f) =>
            result.review.assessments!.some(
              (a) => a.criterionId === f.criterionId && a.verdict === 'needs_revision',
            ),
          );
        if (Buffer.byteLength(JSON.stringify(result.review), 'utf8') > MAX_MODEL_OUTPUT_BYTES)
          throw new AppError('OUTPUT_TOO_LARGE', '核验后的分项结果超过 9 KB，请减少本次审查项。');
      }
      editTask(snapshot.id, (t) => {
        const r = t.runs.find((r) => r.id === run.id)!;
        const s = r.steps[index];
        s.output = result.review;
        s.result = result.review.summary;
        s.status = r.state === 'running' ? 'completed' : 'cancelled';
      });
      return alive(getTask(snapshot.id), run.id) ? result.review : null;
    } catch (error) {
      const message = controller.signal.aborted
        ? '用户已停止；已发请求费用可能仍待核对。'
        : error instanceof AppError
          ? error.message
          : '无法完成模型请求，请检查网络与接口配置；未自动重试。';
      editTask(snapshot.id, (t) => {
        const s = t.runs.find((r) => r.id === run.id)!.steps[index];
        s.status = controller.signal.aborted ? 'cancelled' : 'failed';
        if (!s.sent) s.cost = 0;
        s.error = message;
        s.endedAt = now();
      });
      return null;
    }
  };
  let result: Review | null = null;
  if (run.strategy === 'S1' && run.mode === 'live') {
    const both = await Promise.allSettled([perform(0), perform(1)]);
    const reviews = both.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
    if (reviews.length && alive(getTask(snapshot.id), run.id)) result = await perform(2, reviews);
    if (!result && reviews.length)
      result = {
        summary:
          '比较未完成。以下保留已完成候选：\n\n' +
          reviews.map((r, i) => `候选 ${i + 1}\n${r.summary}`).join('\n\n'),
        findings: [],
        questions: ['候选比较未完成，不生成共同修改。'],
      };
  } else {
    const first = await perform(0);
    result = first;
    if (run.steps.length > 1 && first && alive(getTask(snapshot.id), run.id))
      result = (await perform(1, [first])) ?? first;
  }
  editTask(snapshot.id, (t) => {
    const r = t.runs.find((r) => r.id === run.id)!;
    if (r.state !== 'running') return;
    for (const s of r.steps) if (s.status === 'queued') s.status = 'cancelled';
    r.state = r.steps.every((s) => s.status === 'completed')
      ? 'succeeded'
      : result
        ? 'partial'
        : 'failed';
    r.endedAt = now();
    r.summary = result?.summary || '没有取得可用结果，请查看失败记录。';
    if (result?.assessments && r.state === 'succeeded') r.assessments = result.assessments;
    if (result) {
      supersedeScopedFindings(t, r);
      const findings = normalizeReview(snapshot, result, r.id, r.baseRevision);
      for (const f of findings) {
        if (
          current(t).id !== r.baseRevision ||
          t.sources.find((s) => s.id === f.sourceId)?.version !== f.sourceVersion
        )
          f.stale = true;
      }
      // 未完成的双模型比较不输出修订；任何旧版本结果仅保留，不能静默覆盖当前正文。
      // 同一位置、同一建议不重复制造待办；历史运行与其原始输出仍在记录中。
      for (const f of findings)
        if (
          !t.findings.some(
            (old) =>
              !old.stale &&
              old.criterionId === f.criterionId &&
              (!f.criterionId || old.runId === f.runId) &&
              (old.status === 'pending' || old.status === 'deferred') &&
              old.baseRevision === f.baseRevision &&
              old.sourceId === f.sourceId &&
              old.sourceVersion === f.sourceVersion &&
              old.blockId === f.blockId &&
              old.before === f.before &&
              old.after === f.after,
          )
        )
          t.findings.push(f);
      r.findings = t.findings.filter((f) => f.runId === r.id).map((f) => f.id);
      if (r.discussionQuestion)
        t.messages.push({
          id: uid(),
          actor: 'user',
          content: r.discussionQuestion,
          createdAt: r.createdAt,
          runId: r.id,
        });
      t.messages.push({
        id: uid(),
        actor: 'assistant',
        content:
          r.summary +
          (result.questions.length ? '\n\n待确认：\n' + result.questions.join('\n') : ''),
        model:
          r.mode === 'demo'
            ? '合成示例预览'
            : r.strategy === 'S1'
              ? '独立比较'
              : r.steps.at(-1)?.connectionSnapshot?.label,
        createdAt: now(),
        runId: r.id,
      });
    }
  });
}
export function stopRun(taskId: string, id: string) {
  editTask(taskId, (t) => {
    const r = t.runs.find((r) => r.id === id);
    if (!r) throw new AppError('NOT_FOUND', '运行不存在', 404);
    if (r.state !== 'running') return;
    r.state = 'cancelled';
    r.endedAt = now();
    r.summary = '运行已停止，之前已完成的调用保留在记录中。';
    for (const s of r.steps) if (s.status === 'queued') s.status = 'cancelled';
  });
  controllers.get(JSON.stringify([taskId, id]))?.abort();
}
