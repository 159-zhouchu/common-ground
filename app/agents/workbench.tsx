'use client';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  ClipboardPaste,
  Copy,
  Download,
  History,
  Loader2,
  Play,
  Plus,
  Square,
  X,
} from 'lucide-react';
import { agentRoles, agentRoleNames, type AgentJob, type AgentRequest } from '@/lib/agent-contract';
import { MAX_AGENT_INITIAL_BYTES } from '@/lib/limits';
import { AppLink } from '../site-header';
import type { PublicConnection } from '@/lib/types';
import { collectAgentContext, parseAgentRelay, agentRelayBrief } from '@/lib/agent-relay';

async function call(route: string, body?: unknown) {
  const response = await fetch('/api/' + route, {
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '本机服务请求失败。');
  return data;
}
const emptyRoles: AgentRequest['roles'] = {
  planner: '',
  analyst: '',
  reviewer: '',
  synthesizer: '',
};
const states: Record<string, string> = {
  running: '运行中',
  queued: '等待',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '服务重启中断',
};
const decisions: Record<string, string> = {
  pending: '等待简报',
  ready: '简报可供执行方审阅',
  needs_input: '需要补充信息',
  incomplete: '流程未完整完成',
};
type JobSummary = Pick<AgentJob, 'id' | 'goal' | 'state' | 'createdAt' | 'decision'>;
export default function AgentWorkbench() {
  const [connections, setConnections] = useState<PublicConnection[]>([]),
    [roles, setRoles] = useState(emptyRoles),
    [goal, setGoal] = useState(''),
    [phase, setPhase] = useState<'plan' | 'review'>('plan'),
    [context, setContext] = useState<AgentRequest['context']>([]),
    [budget, setBudget] = useState('');
  const [jobs, setJobs] = useState<JobSummary[]>([]),
    [id, setId] = useState(''),
    [job, setJob] = useState<AgentJob | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [newView, setNewView] = useState(false),
    [refresh, setRefresh] = useState(0),
    [archived, setArchived] = useState<JobSummary[]>([]);
  const [relay, setRelay] = useState(''),
    [copyFallback, setCopyFallback] = useState('');
  const [draftReady, setDraftReady] = useState(false),
    [serviceReady, setServiceReady] = useState(false);
  const key = useRef<string | null>(null),
    sequence = useRef(0),
    restored = useRef(false),
    historyPanel = useRef<HTMLDetailsElement>(null),
    helpPanel = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    call('settings')
      .then((data) => {
        setConnections(data);
        setServiceReady(true);
      })
      .catch((e) => setError(e.message));
    try {
      const saved = JSON.parse(localStorage.getItem('cg-agent-roles') || 'null');
      if (saved && agentRoles.every((r) => typeof saved[r] === 'string')) setRoles(saved);
    } catch {}
    restored.current = true;
  }, []);
  useEffect(() => {
    if (restored.current)
      try {
        localStorage.setItem('cg-agent-roles', JSON.stringify(roles));
      } catch {}
  }, [roles]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem('cg-agent-input');
      if (raw) {
        const saved = JSON.parse(raw),
          input = parseAgentRelay(
            JSON.stringify({
              goal: saved.goal || '暂存任务',
              phase: saved.phase,
              context: saved.context,
            }),
          );
        setGoal(typeof saved.goal === 'string' ? saved.goal : '');
        setPhase(input.phase);
        setContext(input.context);
        if (typeof saved.relay === 'string') setRelay(saved.relay);
        if (typeof saved.budget === 'string') setBudget(saved.budget);
      }
    } catch {}
    setDraftReady(true);
  }, []);
  useEffect(() => {
    if (!draftReady) return;
    const save = () => {
      try {
        localStorage.setItem(
          'cg-agent-input',
          JSON.stringify({ goal, phase, context, relay, budget }),
        );
      } catch {
        setNotice('当前浏览器暂存失败，请先复制重要上下文再离开页面。');
      }
    };
    const timer = setTimeout(save, 350);
    window.addEventListener('pagehide', save);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pagehide', save);
      save();
    };
  }, [draftReady, goal, phase, context, relay, budget]);
  useEffect(() => {
    const guard = (event: Event) => {
      try {
        localStorage.setItem(
          'cg-agent-input',
          JSON.stringify({ goal, phase, context, relay, budget }),
        );
      } catch {
        event.preventDefault();
        setNotice('当前浏览器暂存失败，请先复制重要上下文再离开页面。');
      }
    };
    window.addEventListener('cg-before-navigate', guard);
    return () => window.removeEventListener('cg-before-navigate', guard);
  }, [goal, phase, context, relay, budget]);
  useEffect(() => {
    let cancelled = false;
    const seq = ++sequence.current;
    async function load() {
      try {
        const [list, bin] = await Promise.all([call('agent/jobs'), call('agent/archived')]);
        if (cancelled || seq !== sequence.current) return;
        setJobs(list);
        setArchived(bin);
        const selected = newView ? '' : id || list[0]?.id;
        if (selected) {
          const detail = await call('agent/jobs/' + selected);
          if (!cancelled && seq === sequence.current) setJob(detail);
        } else setJob(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    load();
    const timer = setInterval(load, job?.state === 'running' ? 1500 : 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, job?.state, newView, refresh]);
  const available = connections.filter((c) => c.enabled && c.configured),
    missing = agentRoles.some((r) => !available.some((c) => c.connectionId === roles[r]));
  const participants = new Set(Object.values(roles).filter(Boolean)).size;
  const inputBytes = new TextEncoder().encode(JSON.stringify({ goal, phase, context })).length;
  function editInput(fn: () => void) {
    key.current = null;
    fn();
  }
  async function copy(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFallback('');
      setNotice(message);
    } catch {
      setCopyFallback(text);
      setNotice('自动复制不可用，请从下方文本框中选中并复制。');
    }
  }
  function importRelay() {
    try {
      const input = parseAgentRelay(relay);
      if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_AGENT_INITIAL_BYTES)
        throw new Error('上下文包过大，请让执行 AI 精简到 70 KB 以内。');
      editInput(() => {
        setGoal(input.goal);
        setPhase(input.phase);
        setContext(input.context);
      });
      setRelay('');
      setNotice('已填入目标和上下文。检查内容并选择角色连接后，即可开始自动协作。');
      setError('');
    } catch (e) {
      setError(
        e instanceof SyntaxError
          ? '无法解析 JSON，请粘贴执行 AI 返回的完整 JSON 代码块。'
          : e instanceof Error && e.message.startsWith('上下文包')
            ? e.message
            : '上下文包格式不匹配，需要 goal、phase（plan/review）和 context（name/content 列表）。',
      );
    }
  }
  function downloadBrief() {
    if (!job) return;
    const url = URL.createObjectURL(
      new Blob([agentRelayBrief(job)], { type: 'text/markdown;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = '共桌执行简报-' + job.id.slice(0, 8) + '.md';
    a.click();
    URL.revokeObjectURL(url);
  }
  async function start() {
    setBusy(true);
    setError('');
    try {
      key.current ??= crypto.randomUUID();
      const created = await call('agent/jobs', {
        idempotencyKey: key.current,
        goal,
        phase,
        context,
        roles,
        budget: budget ? Number(budget) : null,
      });
      key.current = null;
      setNewView(false);
      setId(created.id);
      setJob(created);
      setNotice('协作已启动；页面关闭后，本机服务会继续调度。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!job) return;
    setError('');
    try {
      setJob(await call('agent/jobs/' + job.id + '/cancel', {}));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function addFiles(files: FileList | null) {
    if (!files) return;
    setError('');
    try {
      const additions: AgentRequest['context'] = [];
      if (context.length + files.length > 20) throw new Error('最多提交 20 份上下文。');
      for (const file of Array.from(files)) {
        if (
          !/\.(txt|md|json|ts|tsx|js|mjs|jsx|css|py|diff|patch|yaml|yml|toml)$/i.test(file.name) ||
          file.size > 100000
        )
          throw new Error('请选择小于 100 KB 的 UTF-8 代码、文本或 diff 文件。');
        const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        if (content.length > 60000) throw new Error('单份上下文最多 60,000 字符。');
        additions.push({ name: file.name, content });
      }
      editInput(() => setContext([...context, ...additions]));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function download() {
    const input = {
      goal,
      phase,
      roles,
      context,
      budget: budget ? Number(budget) : null,
      files: [],
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(input, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'common-ground-request.json';
    a.click();
    URL.revokeObjectURL(url);
    setNotice('已下载请求配置。执行 Agent 可填充 files，使用命令行自动提交和等待结果。');
  }
  function newCollaboration() {
    if (
      (goal || context.length || relay) &&
      !window.confirm('新建空白协作？当前输入将清空，已保存的协作记录保留。')
    )
      return;
    key.current = null;
    setId('');
    setJob(null);
    setNewView(true);
    setGoal('');
    setContext([]);
    setRelay('');
    setBudget('');
    setPhase('plan');
    setCopyFallback('');
    setError('');
    setNotice('已新建空白协作，模型分工保留。');
  }
  async function manageJob(jobId: string, operation: 'archive' | 'restore') {
    if (
      operation === 'archive' &&
      !window.confirm('将这条协作记录移到回收站？全部角色输出保留，可恢复。')
    )
      return;
    setBusy(true);
    setError('');
    try {
      const result = await call('agent/jobs/' + jobId + '/' + operation, {});
      if (operation === 'archive') {
        setNewView(true);
        setId('');
        setJob(null);
      } else {
        setNewView(false);
        setId(result.id);
        setJob(result);
      }
      setRefresh((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function showHistory() {
    if (historyPanel.current) {
      historyPanel.current.open = true;
      historyPanel.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      historyPanel.current.querySelector('select')?.focus({ preventScroll: true });
    }
  }
  const activeStage =
    job?.state === 'running'
      ? 1
      : job?.state === 'succeeded' && job.decision === 'ready'
        ? 2
        : phase === 'review'
          ? 3
          : 0;
  return (
    <div className="ag-stage">
      <div className="ag-shell">
        <main className="ag-page">
          <div className="ag-breadcrumb">
            <span>
              工作空间 <span className="ag-slash">/</span> AI 协作中转台
            </span>
            <div>
              <span className="ag-service">
                <i className={serviceReady ? 'connected' : ''} />
                {serviceReady ? '本机已连接' : '连接中'}
              </span>
              <a
                href="#ag-help"
                onClick={() => {
                  if (helpPanel.current) helpPanel.current.open = true;
                }}
              >
                使用帮助
              </a>
            </div>
          </div>
          <div className="ag-heading">
            <div>
              <h1>
                让每一轮 AI 协作，<span>接得上。</span>
              </h1>
              <p>带入任务上下文，让顾问模型协作，再把执行简报交回执行 AI。</p>
            </div>
            <div className="ag-actions">
              <button onClick={newCollaboration}>
                <Plus size={17} />
                新建协作
              </button>
              <button onClick={showHistory}>
                <History size={17} />
                查看协作记录
              </button>
            </div>
          </div>
          <ol className="ag-relay-flow" aria-label="协作流程">
            {['带入上下文', '模型分工协作', '交回执行 AI', '带回结果复核'].map((name, i) => (
              <li
                key={name}
                className={activeStage === i ? 'active' : ''}
                aria-current={activeStage === i ? 'step' : undefined}
              >
                <b>0{i + 1}</b>
                {name}
              </li>
            ))}
          </ol>
          {error && (
            <div className="ag-alert ag-error" role="alert">
              <span>{error}</span>
              <button onClick={() => setError('')} aria-label="关闭错误" title="关闭错误">
                <X size={17} />
              </button>
            </div>
          )}
          {notice && (
            <p className="ag-alert" role="status">
              {notice}
            </p>
          )}
          {copyFallback && (
            <label className="ag-copy-fallback">
              手动复制
              <textarea readOnly rows={8} value={copyFallback} onFocus={(e) => e.target.select()} />
            </label>
          )}
          <div className="ag-layout">
            <section className="ag-panel ag-input" aria-labelledby="ag-input-title">
              <h2 id="ag-input-title">接收执行 AI 的任务</h2>
              <p className="ag-subtitle">准备上下文，由你确认后再发送。</p>
              <button
                className="ag-collect"
                onClick={() => copy(collectAgentContext, '任务整理指令已复制，请发送给执行 AI。')}
              >
                <Plus size={17} />
                复制任务整理指令
              </button>
              <label>
                工作目标
                <textarea
                  value={goal}
                  maxLength={12000}
                  rows={2}
                  placeholder="为文件导出功能制定实现与验证计划"
                  onChange={(e) => editInput(() => setGoal(e.target.value))}
                />
              </label>
              <label>
                AI 上下文包
                <textarea
                  aria-label="AI 上下文包"
                  rows={4}
                  value={relay}
                  maxLength={180000}
                  onChange={(e) => setRelay(e.target.value)}
                  placeholder={
                    '粘贴执行 AI 返回的 JSON：目标、相关文件、约束与已有验证结果…\n\n只提交本次需要且获准共享的内容'
                  }
                />
              </label>
              <label className="ag-phase">
                协作阶段
                <select
                  value={phase}
                  onChange={(e) => editInput(() => setPhase(e.target.value as 'plan' | 'review'))}
                >
                  <option value="plan">执行前：规划与实现建议</option>
                  <option value="review">执行后：审查 diff 与验证结果</option>
                </select>
              </label>
              <details className="ag-connect">
                <summary>
                  文件补充与预算{' '}
                  <span>
                    {context.length} 份 · {(inputBytes / 1000).toFixed(1)} KB
                  </span>
                </summary>
                <label>
                  上下文文件
                  <input
                    type="file"
                    multiple
                    accept=".txt,.md,.json,.ts,.tsx,.js,.mjs,.jsx,.css,.py,.diff,.patch,.yaml,.yml,.toml"
                    onChange={(e) => {
                      addFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </label>
                <ul className="ag-files">
                  {context.map((file, i) => (
                    <li key={i}>
                      <span>
                        {file.name} <small>{file.content.length.toLocaleString()} 字符</small>
                      </span>
                      <button
                        aria-label={'移除 ' + file.name}
                        title={'移除 ' + file.name}
                        onClick={() =>
                          editInput(() => setContext(context.filter((_, index) => index !== i)))
                        }
                      >
                        <X size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
                <label>
                  本次预算上限（USD，可选）
                  <input
                    type="number"
                    min="0.000001"
                    max="100"
                    step="any"
                    value={budget}
                    onChange={(e) => editInput(() => setBudget(e.target.value))}
                    placeholder="留空表示不设金额上限"
                  />
                </label>
                <p className="ag-muted">
                  初始上下文上限 70 KB，每步完整输入上限 100 KB；每步结果须在 9 KB
                  内，超限会停止并提示，不会截断。价格或用量缺失时费用未知。
                </p>
              </details>
              <div className="ag-actions ag-submit">
                <button onClick={importRelay} disabled={!relay.trim()}>
                  <ClipboardPaste size={16} />
                  填入上下文
                </button>
                <button
                  className="ag-primary"
                  onClick={start}
                  disabled={
                    busy ||
                    missing ||
                    !goal.trim() ||
                    inputBytes > MAX_AGENT_INITIAL_BYTES ||
                    job?.state === 'running'
                  }
                >
                  {busy ? <Loader2 size={16} className="spin" /> : <Play size={15} />}{' '}
                  {busy ? '提交中…' : '开始自动协作'}
                </button>
              </div>
              <p className="ag-muted ag-consent">选定上下文将发送至所配置的 API 供应商。</p>
              <details className="ag-connect ag-help" id="ag-help" ref={helpPanel}>
                <summary>整理指令与可选接入</summary>
                <p>
                  将整理指令发送给执行 AI，再把返回的完整 JSON
                  粘贴到上下文包。任务输入在当前浏览器暂存。
                </p>
                <textarea aria-label="任务整理指令" readOnly value={collectAgentContext} rows={6} />
                <p>
                  可选命令行 / MCP 接入见项目 <code>docs/Agent接入.md</code>。
                </p>
                <button onClick={download} disabled={missing || !goal.trim()}>
                  <Download size={16} />
                  下载 Agent 请求配置
                </button>
              </details>
            </section>
            <div className="ag-output">
              <section className="ag-panel ag-models" aria-labelledby="ag-model-title">
                <div className="ag-panel-heading">
                  <h2 id="ag-model-title">安排模型分工</h2>
                  <span className="ag-muted">最多 4 次调用</span>
                </div>
                <div className="ag-roles">
                  {agentRoles.map((role, i) => (
                    <label key={role}>
                      <span>
                        <b>0{i + 1}</b>
                        {agentRoleNames[role]}
                        {job?.state === 'running' && (
                          <small>
                            {states[job.steps.find((s) => s.role === role)?.state || 'queued']}
                          </small>
                        )}
                      </span>
                      <select
                        aria-label={agentRoleNames[role]}
                        value={roles[role]}
                        onChange={(e) =>
                          editInput(() => setRoles({ ...roles, [role]: e.target.value }))
                        }
                      >
                        <option value="">选择 API 连接</option>
                        {available.map((c) => (
                          <option key={c.connectionId} value={c.connectionId}>
                            {c.label} · {c.model}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                {missing ? (
                  <p className="ag-muted ag-role-note">
                    请为四个角色选择连接。
                    <AppLink href="/connections">
                      配置模型连接 <ArrowUpRight size={12} />
                    </AppLink>
                  </p>
                ) : (
                  <p className="ag-muted ag-role-note">
                    4 个角色 · {participants} 个连接
                    {participants < 4 ? ' · 复用连接不构成独立模型验证' : ''}
                  </p>
                )}
              </section>
              <section className="ag-panel ag-brief" aria-labelledby="ag-brief-title">
                <div className="ag-panel-heading">
                  <h2 id="ag-brief-title">执行简报</h2>
                  <span
                    className={'ag-decision ' + (job?.decision === 'ready' ? 'ready' : '')}
                    role="status"
                  >
                    {job ? states[job.state] : '等待协作'}
                  </span>
                </div>
                {!job ? (
                  <div className="ag-empty">
                    <h3>一份简报，继续下一步。</h3>
                    <p>步骤、文件范围、风险与验证建议集中在这里。</p>
                  </div>
                ) : (
                  <div className="ag-result">
                    <div className="ag-job-title">
                      <h3>{job.goal}</h3>
                      {job.state === 'running' && (
                        <button onClick={cancel}>
                          <Square size={14} />
                          停止协作
                        </button>
                      )}
                    </div>
                    <p className="ag-muted">{decisions[job.decision]}</p>
                    {job.error && (
                      <p className="ag-inline-error" role="alert">
                        {job.error}
                      </p>
                    )}
                    {job.result ? (
                      <>
                        <p className="ag-prose">{job.result.summary}</p>
                        {job.result.steps.map((step, i) => (
                          <div className="ag-step" key={i}>
                            <b>
                              {i + 1}. {step.task}
                            </b>
                            <p>文件：{step.files.join('、') || '未指定'}</p>
                            <p>验证：{step.checks.join('；') || '待执行方补充'}</p>
                          </div>
                        ))}
                        {!!job.result.risks.length && (
                          <>
                            <h3>风险与分歧</h3>
                            <ul>
                              {job.result.risks.map((r, i) => (
                                <li key={i}>{r}</li>
                              ))}
                            </ul>
                          </>
                        )}
                        {!!job.result.questions.length && (
                          <>
                            <h3>待确认</h3>
                            <ul>
                              {job.result.questions.map((q, i) => (
                                <li key={i}>{q}</li>
                              ))}
                            </ul>
                          </>
                        )}
                      </>
                    ) : (
                      <p className="ag-muted ag-pending">
                        {job.state === 'running'
                          ? '模型正在协作，简报将在汇总完成后显示。'
                          : '本轮尚无汇总结果，可在协作记录中查看各角色输出。'}
                      </p>
                    )}
                  </div>
                )}
                <div className="ag-brief-footer">
                  <p className="ag-muted">
                    {job && job.state !== 'running' && job.decision !== 'ready'
                      ? '当前简报未形成完整执行判断，请先核对协作记录。'
                      : '执行完成后，带回 diff 与测试结果继续复核。'}
                  </p>
                  <div className="ag-actions">
                    <button
                      disabled={!job || job.state === 'running'}
                      onClick={() =>
                        job && copy(agentRelayBrief(job), '简报已复制，请粘贴回 Codex 等执行 AI。')
                      }
                    >
                      <Copy size={16} />
                      复制给执行 AI
                    </button>
                    <button disabled={!job || job.state === 'running'} onClick={downloadBrief}>
                      <Download size={16} />
                      下载 Markdown
                    </button>
                  </div>
                </div>
              </section>
            </div>
          </div>
          <details className="ag-history" ref={historyPanel}>
            <summary>
              <History size={16} />
              协作记录与角色输出<span>{jobs.length} 条记录</span>
            </summary>
            <label>
              协作记录
              <select
                aria-label="协作记录"
                value={id || job?.id || ''}
                onChange={(e) => {
                  key.current = null;
                  setNewView(false);
                  setId(e.target.value);
                }}
              >
                <option value="" disabled>
                  选择协作记录
                </option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {states[j.state]} · {j.goal.slice(0, 40)}
                  </option>
                ))}
                {job && !jobs.some((j) => j.id === job.id) && (
                  <option value={job.id}>
                    {states[job.state]} · {job.goal.slice(0, 40)}
                  </option>
                )}
              </select>
            </label>
            {job && (
              <>
                <button
                  disabled={busy || job.state === 'running'}
                  onClick={() => manageJob(job.id, 'archive')}
                >
                  移到回收站
                </button>
                <p className="ag-muted">
                  {job.id} · {new Date(job.createdAt).toLocaleString('zh-CN')}
                </p>
                <div className="ag-pipeline" aria-label="协作步骤">
                  {job.steps.map((s) => (
                    <details key={s.role}>
                      <summary>
                        <b>{agentRoleNames[s.role]}</b>
                        <span>{states[s.state]}</span>
                      </summary>
                      <p className="ag-muted">
                        {s.connection.label} · {s.connection.model} ·{' '}
                        {s.sent ? '已发送请求' : '尚未发送'} · USD {s.cost ?? '未知'}
                      </p>
                      {s.error && <p role="alert">{s.error}</p>}
                      {s.output && (
                        <>
                          <p className="ag-prose">{s.output.summary}</p>
                          {s.output.steps.map((step, i) => (
                            <div className="ag-step" key={i}>
                              <b>
                                {i + 1}. {step.task}
                              </b>
                              <p>文件：{step.files.join('、') || '未指定'}</p>
                              <p>验证：{step.checks.join('；') || '待执行方补充'}</p>
                            </div>
                          ))}
                          {!!s.output.risks.length && (
                            <>
                              <h3>风险与分歧</h3>
                              <ul>
                                {s.output.risks.map((r, i) => (
                                  <li key={i}>{r}</li>
                                ))}
                              </ul>
                            </>
                          )}
                          {!!s.output.questions.length && (
                            <>
                              <h3>待确认</h3>
                              <ul>
                                {s.output.questions.map((q, i) => (
                                  <li key={i}>{q}</li>
                                ))}
                              </ul>
                            </>
                          )}
                        </>
                      )}
                    </details>
                  ))}
                </div>
              </>
            )}
          </details>
          <details className="ag-history">
            <summary>
              协作回收站<span>{archived.length} 条记录</span>
            </summary>
            {!archived.length && <p className="ag-muted">回收站为空。</p>}
            {archived.map((j) => (
              <div className="ag-actions" key={j.id}>
                <p>{j.goal.slice(0, 60)}</p>
                <button disabled={busy} onClick={() => manageJob(j.id, 'restore')}>
                  恢复协作记录
                </button>
              </div>
            ))}
          </details>
          <footer className="ag-footer">
            流程：规划 → 分析与审查并行 → 汇总；实际修改和测试由执行方完成。
          </footer>
        </main>
      </div>
    </div>
  );
}
