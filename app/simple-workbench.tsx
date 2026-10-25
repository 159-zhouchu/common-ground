'use client';
import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import {
  ChevronDown,
  Plus,
  X,
  FileText,
  BookOpen,
  MoreHorizontal,
  Play,
  Square,
  Download,
  Pencil,
  Save,
  Link2,
  History,
  Settings2,
  MessageSquare,
  HelpCircle,
  Network,
  Upload,
  Info,
  AlertCircle,
  Loader2,
  Search,
  LayoutGrid,
  Activity,
  CheckCheck,
  Layers,
  ArrowUpRight,
} from 'lucide-react';
import type { Task, Block, Finding, PublicConnection, ReviewSpec } from '@/lib/types';
import {
  checkMethods,
  callCount,
  recommendation,
  staleReason,
  filteredFindings,
  runFeedback,
  formatMoney as money,
  draftImportError,
} from '@/lib/presentation';
import { seed } from '@/lib/seed';
import { firstSentence, findingStateNames } from '@/lib/text';
import ConnectionEditor from './connection-editor';
import { documentInputBudget } from '@/lib/document-input';
import { date } from './workbench/format';
import { Sheet, Highlight, JsonBlock, Diff } from './workbench/shared';
import { MaterialsDrawer } from './workbench/materials-drawer';
import { VersionsDrawer } from './workbench/versions-drawer';
import { DiscussionDrawer } from './workbench/discussion-drawer';
import { ReviewControls, AssessmentPanel } from './workbench/review-controls';
import {
  defaultReviewSpec,
  ReviewSpecSchema,
  reviewSpecError,
  prepareCriterionReview,
  reconcileReviewBlocks,
} from '@/lib/review-scope';
import { MAX_BLOCK_CHARACTERS, MAX_DOCUMENT_CHARACTERS } from '@/lib/limits';

type Workspace = {
  tasks: Task[];
  connections: PublicConnection[];
  archivedTasks: { id: string; title: string }[];
};
type Drawer =
  | 'projects'
  | 'new'
  | 'materials'
  | 'settings'
  | 'versions'
  | 'activity'
  | 'help'
  | 'discussion'
  | 'impact'
  | 'export'
  | 'sample'
  | null;
type Method = 'S0' | 'S1' | 'S5';
const stateNames = findingStateNames;
async function api(path: string, body?: unknown) {
  const r = await fetch('/api/' + path, {
    cache: 'no-store',
    ...(body !== undefined
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '请求失败，请重试。');
  return data;
}
function readLocal(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export default function SimpleWorkbench() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null),
    [taskId, setTaskId] = useState(''),
    [started, setStarted] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [offline, setOffline] = useState(false);
  const [drawer, setDrawer] = useState<Drawer>(null),
    [sourceId, setSourceId] = useState<string | null>(null),
    [versionId, setVersionId] = useState(''),
    [selected, setSelected] = useState<string | null>(null),
    [filter, setFilter] = useState<'pending' | 'all' | 'resolved' | 'stale'>('pending'),
    [mobile, setMobile] = useState<'document' | 'suggestions'>('document');
  const [method, setMethod] = useState<Method>('S0'),
    [mode, setMode] = useState<'demo' | 'live'>('live'),
    [modeTask, setModeTask] = useState(''),
    [selfCheck, setSelfCheck] = useState(true),
    [primary, setPrimary] = useState(''),
    [secondary, setSecondary] = useState(''),
    [compareRole, setCompareRole] = useState<'a' | 'b'>('a'),
    [context, setContext] = useState<'continue' | 'source_only'>('continue'),
    [budget, setBudget] = useState('');
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState<Block[]>([]),
    [draftConstraint, setDraftConstraint] = useState(''),
    [draftBase, setDraftBase] = useState(''),
    [draftTask, setDraftTask] = useState(''),
    [draftStatus, setDraftStatus] = useState(''),
    [hasDraft, setHasDraft] = useState(false),
    [draftInfo, setDraftInfo] = useState('');
  const [title, setTitle] = useState(''),
    [goal, setGoal] = useState(''),
    [content, setContent] = useState(''),
    [constraint, setConstraint] = useState(''),
    [question, setQuestion] = useState(''),
    [receiver, setReceiver] = useState(''),
    [format, setFormat] = useState('docx'),
    [includeReview, setIncludeReview] = useState(true);
  const [renameId, setRenameId] = useState(''),
    [renameTitle, setRenameTitle] = useState('');
  const [reviewConfig, setReviewConfig] = useState<ReviewSpec>(defaultReviewSpec),
    [reviewSelection, setReviewSelection] = useState<string[]>(['overall']);
  const scopedReview = method === 'S5' || context === 'continue';
  const reviewSpec = useMemo(
    () => ({
      ...reviewConfig,
      criteria: reviewConfig.criteria.filter((c) => reviewSelection.includes(c.id)),
    }),
    [reviewConfig, reviewSelection],
  );
  const submission = useRef<{ signature: string; id: string } | null>(null),
    discussionSubmission = useRef<{ signature: string; id: string } | null>(null);
  const [pendingDiscussion, setPendingDiscussion] = useState<{
    taskId: string;
    runId: string;
    text: string;
  } | null>(null);
  const [replaceId, setReplaceId] = useState(''),
    [detailTask, setDetailTask] = useState<Task | null>(null);
  useEffect(() => {
    const view = new URLSearchParams(window.location.search).get('view');
    if (view === 'materials' || view === 'versions') {
      setDrawer(view);
      setStarted(true);
    }
  }, []);
  const workspaceTag = useRef(''),
    loadSeq = useRef(0),
    appRoot = useRef<HTMLDivElement>(null),
    heights = useRef<{ bar?: number }>({});
  const projectMenu = useRef<HTMLDetailsElement>(null),
    moreMenu = useRef<HTMLDetailsElement>(null),
    methodMenu = useRef<HTMLDetailsElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    draftInput = useRef<HTMLInputElement>(null),
    lastTask = useRef(''),
    selectionTask = useRef(''),
    drawerFocus = useRef<HTMLElement | null>(null),
    positions = useRef({ document: 0, suggestions: 0 });
  const listTask = workspace?.tasks.find((t) => t.id === taskId) ?? workspace?.tasks[0];
  const task =
    detailTask?.id === listTask?.id &&
    detailTask?.updatedAt === listTask?.updatedAt &&
    ['versions', 'activity'].includes(drawer || '')
      ? detailTask
      : listTask;
  useEffect(() => {
    if (!listTask || !['versions', 'activity'].includes(drawer || '')) return;
    let cancelled = false;
    api('task-detail?taskId=' + encodeURIComponent(listTask.id))
      .then((t) => {
        if (!cancelled) setDetailTask(t);
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [drawer, listTask?.id, listTask?.updatedAt]);
  useEffect(() => {
    if (!['versions', 'activity'].includes(drawer || '')) setDetailTask(null);
  }, [drawer]);
  const revision = task?.revisions.find((r) => r.id === task.currentRevision);
  const reviewError = task && scopedReview ? reviewSpecError(reviewSpec, task) : '';
  const active = task?.runs.find((r) => r.state === 'running'),
    latest = task?.runs.at(-1);
  const finding = task?.findings.find((f) => f.id === selected),
    source = task?.sources.find((s) => s.id === sourceId);
  const dirty = useMemo(
    () =>
      editing &&
      !!revision &&
      (JSON.stringify(draft) !== JSON.stringify(revision.blocks) ||
        draftConstraint !== revision.constraint),
    [editing, revision, draft, draftConstraint],
  );
  const pending =
    task?.findings.filter((f) => !f.stale && (f.status === 'pending' || f.status === 'deferred'))
      .length ?? 0;
  const staleCount =
    task?.findings.filter(
      (f) => f.stale && !f.supersededBy && (f.status === 'pending' || f.status === 'deferred'),
    ).length ?? 0;
  const completedCalls =
    task?.runs
      .filter((r) => r.mode === 'live')
      .flatMap((r) => r.steps)
      .filter((s) => s.sent) ?? [];
  const knownCost = completedCalls.reduce((total, s) => total + (s.cost ?? 0), 0);
  const acceptedCount = task?.findings.filter((f) => f.status === 'accepted').length ?? 0;
  const showWelcome =
    workspace &&
    (!task ||
      (!started &&
        workspace.tasks.every((t) => t.example && !t.runs.length && t.revisions.length === 1)));
  useEffect(() => {
    const node = document.querySelector('.cg-checkbar');
    if (!node) return;
    const write = () => {
      const h = node.getBoundingClientRect().height;
      if (Math.abs((heights.current.bar ?? 0) - h) < 0.5) return;
      heights.current.bar = h;
      appRoot.current?.style.setProperty('--bar-height', h + 'px');
    };
    write();
    const observer = new ResizeObserver(write);
    observer.observe(node);
    return () => observer.disconnect();
  }, [task?.id, showWelcome]);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const response = await fetch('/api/workspace?view=summary', {
        cache: 'no-store',
        headers: workspaceTag.current ? { 'If-None-Match': workspaceTag.current } : {},
      });
      if (seq !== loadSeq.current) return;
      if (response.status === 304) {
        setOffline(false);
        return;
      }
      if (!response.ok) throw new Error('无法读取工作区。');
      const data = (await response.json()) as Workspace;
      if (seq !== loadSeq.current) return;
      workspaceTag.current = response.headers.get('etag') || '';
      setWorkspace(data);
      setOffline(false);
      setTaskId((id) => {
        const preferred = id || readLocal('cg-task');
        return data.tasks.some((t) => t.id === preferred) ? preferred! : data.tasks[0]?.id || '';
      });
      setStarted(
        (old) =>
          old ||
          readLocal('cg-started') === 'true' ||
          data.tasks.some((t) => !t.example || t.runs.length > 0 || t.revisions.length > 1),
      );
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setOffline(true);
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const timer = setInterval(
      () => {
        if (!document.hidden) load();
      },
      active ? 1800 : 8000,
    );
    const visible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [load, !!active]);
  useEffect(() => {
    if (!task || lastTask.current === task.id) return;
    lastTask.current = task.id;
    setMode(task.example ? 'demo' : 'live');
    setModeTask(task.id);
    let selection;
    try {
      selection = JSON.parse(readLocal('cg-connections-' + task.id) || 'null');
    } catch {}
    setPrimary(selection?.a || '');
    setSecondary(selection?.b || '');
    setCompareRole(selection?.compareRole === 'b' ? 'b' : 'a');
    setReceiver(selection?.receiver || '');
    let savedReview;
    try {
      savedReview = ReviewSpecSchema.safeParse(
        JSON.parse(readLocal('cg-review-' + task.id) || 'null'),
      );
    } catch {}
    const spec = reconcileReviewBlocks(
      savedReview?.success ? savedReview.data : defaultReviewSpec(),
      task.revisions.find((r) => r.id === task.currentRevision)!.blocks,
    );
    setReviewConfig(spec);
    setReviewSelection(spec.criteria.map((c) => c.id));
    selectionTask.current = task.id;
    setSelected(null);
    setFilter('pending');
    setEditing(false);
    setHasDraft(!!readLocal('cg-draft-' + task.id));
    try {
      const saved = JSON.parse(readLocal('cg-draft-' + task.id) || 'null');
      setDraftInfo(
        saved
          ? `基于 v${task.revisions.find((r) => r.id === saved.base)?.number ?? '?'} · ${saved.savedAt ? date(saved.savedAt) : '暂存时间未记录'}`
          : '',
      );
    } catch {
      setDraftInfo('');
    }
    positions.current = { document: 0, suggestions: 0 };
    try {
      localStorage.setItem('cg-task', task.id);
    } catch {}
  }, [task]);
  useEffect(() => {
    if (!task || !revision || selectionTask.current !== task.id) return;
    setReviewConfig((previous) => {
      const next = reconcileReviewBlocks(previous, revision.blocks);
      if (next !== previous) {
        try {
          localStorage.setItem('cg-review-' + task.id, JSON.stringify(next));
        } catch {}
      }
      return next;
    });
  }, [task?.id, revision?.id]);
  function persistDraft() {
    if (!editing || !dirty || !task || draftTask !== task.id) return true;
    try {
      localStorage.setItem(
        'cg-draft-' + task.id,
        JSON.stringify({
          blocks: draft,
          constraint: draftConstraint,
          base: draftBase,
          savedAt: new Date().toISOString(),
        }),
      );
      setDraftStatus('草稿已在本机暂存');
      setHasDraft(true);
      setDraftInfo(
        `基于 v${task.revisions.find((r) => r.id === draftBase)?.number ?? '?'} · ${date(new Date().toISOString())}`,
      );
      return true;
    } catch {
      setDraftStatus('暂存失败，请保持页面打开并保存');
      return false;
    }
  }
  useEffect(() => {
    if (!editing || !dirty || !task || draftTask !== task.id) return;
    const timer = setTimeout(persistDraft, 400);
    return () => clearTimeout(timer);
  }, [draft, draftConstraint, draftBase, editing, dirty, task?.id, draftTask]);
  useEffect(() => {
    const flush = () => {
      persistDraft();
    };
    const hidden = () => {
      if (document.hidden) flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [draft, draftConstraint, draftBase, editing, dirty, task?.id, draftTask]);
  useEffect(() => {
    const fn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', fn);
    return () => window.removeEventListener('beforeunload', fn);
  }, [dirty]);
  useEffect(() => {
    const guard = (event: Event) => {
      if (!persistDraft()) {
        event.preventDefault();
        setError('草稿暂存失败，请先保存或复制内容再切换页面。');
      }
    };
    window.addEventListener('cg-before-navigate', guard);
    return () => window.removeEventListener('cg-before-navigate', guard);
  }, [draft, draftConstraint, draftBase, editing, dirty, task?.id, draftTask]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const close = (event: PointerEvent | KeyboardEvent) => {
      for (const ref of [projectMenu, moreMenu, methodMenu]) {
        if (
          ref.current?.open &&
          (event instanceof KeyboardEvent
            ? event.key === 'Escape'
            : !ref.current.contains(event.target as Node))
        )
          ref.current.open = false;
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  function rememberSelection(p: {
    a?: string;
    b?: string;
    compareRole?: 'a' | 'b';
    receiver?: string;
  }) {
    if (!task || selectionTask.current !== task.id) return;
    try {
      localStorage.setItem(
        'cg-connections-' + task.id,
        JSON.stringify({ a: primary, b: secondary, compareRole, receiver, ...p }),
      );
    } catch {}
  }
  function begin() {
    setStarted(true);
    try {
      localStorage.setItem('cg-started', 'true');
    } catch {}
  }
  function chooseMethod(next: Method) {
    setMethod(next);
    if (next === 'S5') setContext('continue');
    if (methodMenu.current) {
      methodMenu.current.open = false;
      methodMenu.current.querySelector('summary')?.focus();
    }
  }
  function showBlock(f: Finding, focus = true) {
    setMobile('document');
    requestAnimationFrame(() => {
      const block = document.getElementById('block-' + f.blockId);
      (block?.querySelector('mark') ?? block)?.scrollIntoView({
        block: 'center',
        behavior: 'instant',
      });
      if (focus) block?.focus({ preventScroll: true });
    });
  }
  function open(d: Drawer) {
    const active = document.activeElement as HTMLElement | null;
    drawerFocus.current =
      (active?.closest('details')?.querySelector('summary') as HTMLElement | null) ?? active;
    if (moreMenu.current) moreMenu.current.open = false;
    if (projectMenu.current) projectMenu.current.open = false;
    setDrawer(d);
  }
  async function action(fn: () => Promise<unknown>, message?: string) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
      if (message) setNotice(message);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function sampleFlow() {
    const sample = workspace?.tasks.find((t) => t.example);
    if (sample) {
      switchTask(sample.id);
      setMode('demo');
    } else open('sample');
  }
  function switchTask(id: string) {
    if (editing && dirty && draftStatus.startsWith('暂存失败')) {
      setError('草稿暂存失败，请先保存或复制内容再切换项目。');
      return;
    }
    if (!persistDraft()) {
      setError('草稿暂存失败，请先保存或复制内容再切换项目。');
      return;
    }
    if (dirty) setNotice('原项目的草稿已保留，切回后可继续编辑。');
    setEditing(false);
    setTaskId(id);
    setSourceId(null);
    setDrawer(null);
    setDetailTask(null);
    setVersionId('');
    setMobile('document');
    begin();
    if (projectMenu.current) projectMenu.current.open = false;
  }
  function edit() {
    if (!task || !revision) return;
    let old;
    try {
      old = JSON.parse(readLocal('cg-draft-' + task.id) || 'null');
    } catch {}
    if (
      old &&
      Array.isArray(old.blocks) &&
      typeof old.constraint === 'string' &&
      typeof old.base === 'string'
    ) {
      setDraft(old.blocks);
      setDraftConstraint(old.constraint);
      setDraftBase(old.base);
      if (old.base !== revision.id)
        setNotice('恢复的是旧版草稿。请复制重要内容；保存时会检查版本，不能覆盖新稿。');
    } else {
      setDraft(structuredClone(revision.blocks));
      setDraftConstraint(revision.constraint);
      setDraftBase(revision.id);
    }
    setDraftStatus(old ? '已恢复本机暂存草稿' : '尚未修改');
    setDraftTask(task.id);
    setEditing(true);
    setMobile('document');
  }
  async function save() {
    if (!task || !revision) return;
    const ok = await action(
      () =>
        api('save', {
          taskId: task.id,
          base: draftBase,
          blocks: draft,
          constraint: draftConstraint,
        }),
      '已保存新版本，原版本保留。',
    );
    if (ok) {
      try {
        localStorage.removeItem('cg-draft-' + task.id);
      } catch {}
      setEditing(false);
      setHasDraft(false);
    }
  }
  async function start() {
    if (!task) return;
    if (dirty) {
      setError('请先保存正文草稿，再开始检查。');
      return;
    }
    if (reviewError) {
      setError(reviewError);
      return;
    }
    const runMode = task.example ? (modeTask === task.id ? mode : 'demo') : 'live';
    if (runMode === 'live' && missing) {
      setError('请为本次任务选择已启用、已配置的连接；原连接停用或删除后须重新选择。');
      return;
    }
    const payload = {
      taskId: task.id,
      base: task.currentRevision,
      strategy: method,
      selfCheck,
      mode: runMode,
      contextMode: method === 'S5' ? 'continue' : context,
      slot: 'a',
      ...(runMode === 'live'
        ? { roleAssignments: { a: primary, ...(method !== 'S0' ? { b: secondary } : {}) } }
        : {}),
      compareRole,
      budget: budget ? Number(budget) : null,
      ...(scopedReview ? { reviewSpec } : {}),
    };
    const signature = JSON.stringify(payload);
    if (submission.current?.signature !== signature)
      submission.current = { signature, id: crypto.randomUUID() };
    const idempotencyKey = submission.current.id;
    const ok = await action(async () => {
      await api('runs', { ...payload, idempotencyKey });
      submission.current = null;
    });
    if (ok) {
      begin();
      setFilter('pending');
      switchMobile('suggestions');
      setSelected(null);
      if (methodMenu.current) methodMenu.current.open = false;
    }
  }
  async function decide(f: Finding, decision: 'accepted' | 'rejected' | 'deferred' | 'pending') {
    if (!task || !revision) return;
    if (dirty) {
      setError('请先保存正文草稿，再处理修改建议。');
      return;
    }
    const ok = await action(
      () => api('patch', { taskId: task.id, id: f.id, base: revision.id, decision }),
      decision === 'accepted' ? '已接受修改并保存新版本。' : '处理决定已保存。',
    );
    if (
      ok &&
      (decision === 'accepted' || !filteredFindings([{ ...f, status: decision }], filter).length)
    )
      setSelected(null);
  }
  async function create() {
    const ok = await action(async () => {
      const t = await api('task', { title, goal, content, constraint });
      setEditing(false);
      setTaskId(t.id);
      setMode('live');
      begin();
    }, '方案已导入。');
    if (ok) {
      setDrawer(null);
      setTitle('');
      setContent('');
      setGoal('');
      setConstraint('');
      setMobile('document');
    }
  }
  async function importDraft(file: File) {
    if (!/\.(txt|md)$/i.test(file.name) || file.size > 300000) {
      setError('原稿支持 UTF-8 TXT / Markdown，大小不超过 300 KB；也可直接粘贴。');
      return;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      const problem = draftImportError(file.size, text);
      if (problem) {
        setError(problem);
        return;
      }
      setContent(text);
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
    } catch {
      setError('请将原稿另存为 UTF-8 编码后再导入。');
    }
  }
  async function upload(file: File) {
    if (!task) return;
    const ok = await action(
      async () => {
        const form = new FormData();
        form.set('taskId', task.id);
        form.set('file', file);
        if (replaceId) form.set('replaceId', replaceId);
        const r = await fetch('/api/material', { method: 'POST', body: form });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        setSourceId(data.id);
      },
      replaceId ? '材料已更新，旧引用保留。' : '材料已导入。',
    );
    if (ok) setReplaceId('');
    if (fileInput.current) fileInput.current.value = '';
  }
  async function send() {
    if (!task || !question.trim()) return;
    if (dirty) {
      setError('请先保存正文草稿，再继续讨论。');
      return;
    }
    const sentText = question,
      payload = {
        taskId: task.id,
        base: task.currentRevision,
        connectionId: receiver,
        text: sentText,
      },
      signature = JSON.stringify(payload);
    if (discussionSubmission.current?.signature !== signature)
      discussionSubmission.current = { signature, id: crypto.randomUUID() };
    const idempotencyKey = discussionSubmission.current.id;
    await action(async () => {
      const run = await api('message', { ...payload, idempotencyKey });
      discussionSubmission.current = null;
      setPendingDiscussion({ taskId: task.id, runId: run.id, text: sentText });
    });
  }
  function download() {
    if (!task || !revision) return;
    const a = document.createElement('a');
    a.href = `/api/export?taskId=${encodeURIComponent(task.id)}&revision=${encodeURIComponent(revision.id)}&format=${format}&review=${includeReview}`;
    a.download = `共桌-${task.title}.${format}`;
    a.click();
    setNotice('已请求导出当前保存版本。');
    setDrawer(null);
  }
  function changeReviewConfig(spec: ReviewSpec) {
    setReviewConfig(spec);
    if (!task) return;
    try {
      localStorage.setItem('cg-review-' + task.id, JSON.stringify(spec));
    } catch {
      setError('审查设置暂存失败，请保持页面打开。');
    }
  }
  function switchMobile(next: 'document' | 'suggestions') {
    positions.current[mobile] = window.scrollY;
    setMobile(next);
    requestAnimationFrame(() => {
      const tabs = document.querySelector('.cg-mobile-tabs'),
        top =
          next === 'suggestions' && tabs
            ? Math.max(
                positions.current[next],
                tabs.getBoundingClientRect().top + window.scrollY - (heights.current.bar ?? 96),
              )
            : positions.current[next];
      window.scrollTo({ top, behavior: 'instant' });
    });
  }
  const runMode = task ? (task.example ? (modeTask === task.id ? mode : 'demo') : 'live') : 'live',
    calls = runMode === 'demo' ? 0 : callCount(method, selfCheck),
    methodInfo = checkMethods.find((m) => m.id === method)!;
  const recommended = task && workspace ? recommendation(task, workspace.connections) : null;
  const chosenIds = method === 'S0' ? [primary] : [primary, secondary];
  useEffect(() => {
    if (!pendingDiscussion) return;
    const run = workspace?.tasks
      .find((t) => t.id === pendingDiscussion.taskId)
      ?.runs.find((r) => r.id === pendingDiscussion.runId);
    if (!run || run.state === 'running') return;
    if (run.state === 'succeeded' && taskId === pendingDiscussion.taskId)
      setQuestion((q) => (q === pendingDiscussion.text ? '' : q));
    setPendingDiscussion(null);
  }, [workspace, pendingDiscussion, taskId]);
  async function archiveProject(t: Task) {
    if (!persistDraft()) {
      setError('草稿暂存失败，请先保存后再管理项目。');
      return;
    }
    if (!window.confirm('将“' + t.title + '”移到回收站？正文、历史和本机草稿保留，可恢复。'))
      return;
    await action(async () => {
      await api('task/archive', { taskId: t.id, base: t.currentRevision });
      if (taskId === t.id) {
        setEditing(false);
        setTaskId('');
      }
    }, '已移到回收站，可在项目管理中恢复。');
  }
  const available = workspace?.connections.filter((c) => c.enabled) ?? [];
  const missing = chosenIds.some(
    (id) => !id || !available.some((c) => c.connectionId === id && c.configured),
  );
  const firstConnection = workspace?.connections.find((c) => c.connectionId === primary),
    secondConnection = workspace?.connections.find((c) => c.connectionId === secondary);
  const sameModel =
    method !== 'S0' &&
    firstConnection &&
    secondConnection &&
    (primary === secondary || firstConnection.model === secondConnection.model);
  const connectionOptions = (value: string) => (
    <>
      <option value="">请选择连接</option>
      {value && !available.some((c) => c.connectionId === value) && (
        <option value={value} disabled>
          原连接已停用或删除，请重新选择
        </option>
      )}
      {available.map((c) => (
        <option key={c.connectionId} value={c.connectionId} disabled={!c.configured}>
          {c.label} · {c.model || '缺模型 ID'}
          {!c.hasKey ? '（缺 API Key）' : ''}
        </option>
      ))}
    </>
  );

  const needsMaterials = method === 'S5' && !task?.sources.length;

  const inputBudget = useMemo(
    () =>
      task && revision
        ? documentInputBudget(task, {
            strategy: method,
            selfCheck,
            contextMode: method === 'S5' ? 'continue' : context,
            mode: 'live',
            slot: 'a',
            budget: null,
            ...(scopedReview ? { reviewSpec } : {}),
          })
        : null,
    [task, revision, context, method, selfCheck, scopedReview, reviewSpec],
  );
  const inputBytes = inputBudget?.bytes ?? 0,
    inputLimit = inputBudget?.limit ?? 100000;
  const inputTooLarge = runMode === 'live' && !!inputBudget?.exceeded;
  const draftLength = draft.reduce((n, b) => n + b.content.length, 0),
    draftTooLong =
      draftLength > MAX_DOCUMENT_CHARACTERS ||
      draft.some((b) => b.content.length > MAX_BLOCK_CHARACTERS);
  const runBlocked =
    busy ||
    !!active ||
    !!dirty ||
    !!reviewError ||
    (runMode === 'live' && (missing || needsMaterials || inputTooLarge));
  const titles: Record<NonNullable<Drawer>, string> = {
    projects: '项目管理与回收站',
    new: '导入我的方案',
    materials: '材料与依据',
    settings: 'API 设置',
    versions: '版本历史',
    activity: '调用记录',
    help: '使用帮助',
    discussion: '继续讨论',
    impact: '变更影响',
    export: '导出方案',
    sample: '示例方案',
  };

  return (
    <div className="cg-app" ref={appRoot} role="region" aria-label="文稿工作空间">
      <div className="cg-header" role="region" aria-label="项目工具栏">
        <span className="cg-breadcrumb">
          文稿项目 <span>/</span>
        </span>
        <details className="cg-project-picker" ref={projectMenu}>
          <summary aria-label={'切换项目：' + (!showWelcome && task ? task.title : '选择项目')}>
            <span>{!showWelcome && task ? task.title : '选择项目'}</span>
            <ChevronDown size={16} />
          </summary>
          <div className="cg-menu">
            {workspace?.tasks.map((t) => (
              <button
                key={t.id}
                onClick={() => switchTask(t.id)}
                aria-current={task?.id === t.id ? 'true' : undefined}
              >
                <FileText size={16} />
                <span>{t.title}</span>
                {t.example && <small>示例</small>}
              </button>
            ))}
            <button onClick={() => open('new')}>
              <Plus size={16} />
              新建项目 / 导入方案
            </button>
            <button onClick={() => open('projects')}>
              <History size={16} />
              项目管理与回收站
            </button>
          </div>
        </details>
        <nav aria-label="文档操作">
          <span className="cg-local-status">
            <span className={offline ? 'is-offline' : ''} />
            {offline ? '连接中断' : '本机已连接'}
          </span>
          <button
            className="cg-nav-button"
            aria-label="材料"
            title="材料"
            onClick={() => {
              setSourceId(null);
              open('materials');
            }}
            disabled={!task || !!showWelcome}
          >
            <BookOpen size={16} />
            <span>材料</span>
            {!showWelcome && !!task?.sources.length && <small>{task.sources.length}</small>}
          </button>
          <button
            className="cg-nav-button"
            aria-label="版本"
            title="版本"
            onClick={() => open('versions')}
            disabled={!task || !!showWelcome}
          >
            <History size={16} />
            <span>版本</span>
          </button>
          <button
            className="cg-nav-button"
            aria-label="讨论"
            title="讨论"
            onClick={() => open('discussion')}
            disabled={!task || !!showWelcome}
          >
            <MessageSquare size={16} />
            <span>讨论</span>
          </button>
          <details className="cg-more" ref={moreMenu}>
            <summary aria-label="更多">
              <MoreHorizontal size={19} />
              <span>更多</span>
            </summary>
            <div className="cg-menu cg-menu-right">
              {(
                [
                  ['projects', LayoutGrid, '项目管理与回收站'],
                  ['settings', Settings2, 'API 设置'],
                  ['versions', History, '版本历史'],
                  ['activity', FileText, '调用记录'],
                  ['discussion', MessageSquare, '继续讨论'],
                  ['impact', Network, '变更影响'],
                  ['help', HelpCircle, '使用帮助'],
                ] as const
              ).map(([key, Icon, name]) => (
                <button
                  key={key}
                  onClick={() => open(key)}
                  disabled={
                    (!task || !!showWelcome) && !['projects', 'settings', 'help'].includes(key)
                  }
                >
                  <Icon size={16} />
                  {name}
                </button>
              ))}
            </div>
          </details>
        </nav>
      </div>
      {!workspace ? (
        <main className="cg-loading" id="main-content" tabIndex={-1}>
          <Loader2 className="spin" />
          正在打开共桌{error && <button onClick={load}>重新连接</button>}
        </main>
      ) : showWelcome ? (
        <main className="cg-welcome" id="main-content" tabIndex={-1}>
          <div className="cg-empty-heading">
            <span className="cg-eyebrow">WORKSPACE</span>
            <h1>项目工作台</h1>
            <p>导入文稿、连接模型，在同一处审阅与修订。</p>
          </div>
          <div className="cg-welcome-grid">
            <section className="cg-welcome-paper">
              <div className="cg-empty-icon">
                <FileText size={26} />
              </div>
              <h2>创建第一个项目</h2>
              <p>支持 TXT / Markdown 原稿；参考材料另支持 DOCX。</p>
              <button className="cg-primary" onClick={() => open('new')}>
                <Plus size={17} />
                导入我的方案
              </button>
              <small>检查需要 API 连接。导入后可先编辑、保存与导出。</small>
            </section>
            <section className="cg-setup-panel">
              <h2>开始前</h2>
              <ol>
                <li>
                  <span>01</span>
                  <div>
                    <b>放入你的文稿</b>
                    <p>正文、目标与材料分别保存。</p>
                  </div>
                </li>
                <li>
                  <span>02</span>
                  <div>
                    <b>接入你选择的模型</b>
                    <p>仅在你点击检查时调用，按量计费。</p>
                    <button className="cg-text-button" onClick={() => open('settings')}>
                      配置 API 连接 <ArrowUpRight size={14} />
                    </button>
                  </div>
                </li>
                <li>
                  <span>03</span>
                  <div>
                    <b>逐条核对再采纳</b>
                    <p>每次修改生成新版本，可随时回看。</p>
                  </div>
                </li>
              </ol>
              <button className="cg-secondary" onClick={sampleFlow}>
                <Play size={15} />
                打开示例项目
              </button>
              <small>合成预置问题 · 无需 Key · 不调用模型</small>
            </section>
          </div>
        </main>
      ) : (
        task &&
        revision && (
          <>
            <section className="cg-overview" aria-label="项目概览">
              <div className="cg-overview-heading">
                <div>
                  <span className="cg-eyebrow">DOCUMENT WORKSPACE</span>
                  <h1>
                    <span className="cg-project-title">{task.title}</span>
                    <span className="cg-project-type">
                      {task.example ? '合成示例' : '个人项目'}
                    </span>
                  </h1>
                  <p>
                    {active ? '正在按所选方式检查文稿。' : '围绕一份文稿，保留依据与每一次修订。'}
                  </p>
                </div>
                <button className="cg-secondary cg-new-project" onClick={() => open('new')}>
                  <Plus size={15} />
                  新建项目
                </button>
              </div>
              <div className="cg-metrics">
                <button
                  onClick={() => {
                    setSourceId(null);
                    open('materials');
                  }}
                >
                  <span className="cg-metric-icon">
                    <BookOpen size={17} />
                  </span>
                  <span className="cg-metric-label">参考材料</span>
                  <b>
                    {task.sources.length}
                    <small>份</small>
                  </b>
                  <span className="cg-metric-note">
                    {task.sources.length ? '原文与版本可追溯' : '等待导入材料'}
                  </span>
                  <ArrowUpRight size={13} />
                </button>
                <button
                  className="cg-metric-review"
                  onClick={() => {
                    setFilter('pending');
                    setMobile('suggestions');
                    requestAnimationFrame(() =>
                      document
                        .getElementById('suggestions-panel')
                        ?.scrollIntoView({ block: 'start', behavior: 'instant' }),
                    );
                  }}
                >
                  <span className="cg-metric-icon">
                    <Layers size={17} />
                  </span>
                  <span className="cg-metric-label">待处理建议</span>
                  <b>
                    {pending}
                    <small>条</small>
                  </b>
                  <span className="cg-metric-note">
                    {staleCount ? staleCount + ' 条另需重查' : '由你决定是否采纳'}
                  </span>
                  <ArrowUpRight size={13} />
                </button>
                <button onClick={() => open('versions')}>
                  <span className="cg-metric-icon">
                    <CheckCheck size={17} />
                  </span>
                  <span className="cg-metric-label">已采纳修订</span>
                  <b>
                    {acceptedCount}
                    <small>条</small>
                  </b>
                  <span className="cg-metric-note">当前 v{revision.number} · 历史保留</span>
                  <ArrowUpRight size={13} />
                </button>
                <button onClick={() => open('activity')}>
                  <span className="cg-metric-icon">
                    <Activity size={17} />
                  </span>
                  <span className="cg-metric-label">模型调用</span>
                  <b>
                    {completedCalls.filter((s) => s.slot !== 'demo').length}
                    <small>次</small>
                  </b>
                  <span className="cg-metric-note">
                    {completedCalls.some((s) => s.cost === null)
                      ? '部分费用待核对'
                      : knownCost
                        ? money(knownCost)
                        : '暂无已计费用'}
                  </span>
                </button>
              </div>
            </section>
            <section className="cg-checkbar" aria-label="检查操作">
              <div className="cg-check-controls">
                <div className="cg-check-combo">
                  <button
                    className="cg-primary"
                    disabled={!!runBlocked}
                    aria-describedby="check-preview"
                    onClick={start}
                  >
                    {busy ? <Loader2 size={16} className="spin" /> : <Play size={16} />}开始检查
                  </button>
                  <details className="cg-method-picker" ref={methodMenu}>
                    <summary aria-label={'选择检查方式：' + methodInfo.name}>
                      <span>{methodInfo.name}</span>
                      <ChevronDown size={15} />
                    </summary>
                    <div className="cg-method-menu">
                      <h3>这次怎么检查？</h3>
                      {checkMethods.map((m) => (
                        <button
                          className={method === m.id ? 'chosen' : ''}
                          key={m.id}
                          disabled={!!active}
                          onClick={() => chooseMethod(m.id)}
                        >
                          <b>
                            {m.name}
                            <small>
                              {runMode === 'demo'
                                ? '演示 · 0 次调用'
                                : callCount(m.id, selfCheck) + ' 次调用'}
                            </small>
                          </b>
                          <span>{m.description}</span>
                          {method === m.id && <span className="cg-selected-label">当前选择</span>}
                        </button>
                      ))}
                      {recommended && runMode === 'live' && (
                        <div className="cg-recommendation">
                          <p>
                            建议{checkMethods.find((m) => m.id === recommended.strategy)?.name}：
                            {recommended.reason}
                          </p>
                          {recommended.strategy !== method && (
                            <button
                              onClick={() => chooseMethod(recommended.strategy)}
                              disabled={!!active}
                            >
                              使用推荐方式
                            </button>
                          )}
                          <small>只提供建议；选择与开始均由你决定。</small>
                        </div>
                      )}
                      <details className="cg-method-details">
                        <summary>输入、费用与机制详情</summary>
                        <label>
                          运行方式
                          <select
                            aria-label="运行方式"
                            value={runMode}
                            disabled={!!active}
                            onChange={(e) => {
                              setMode(e.target.value as 'demo' | 'live');
                              setModeTask(task.id);
                            }}
                          >
                            {task.example && <option value="demo">示例体验（不调用模型）</option>}
                            <option value="live">真实模型运行</option>
                          </select>
                        </label>
                        {method === 'S0' && (
                          <>
                            <label className="cg-checkbox">
                              <input
                                type="checkbox"
                                checked={selfCheck}
                                disabled={!!active || runMode === 'demo'}
                                onChange={(e) => setSelfCheck(e.target.checked)}
                              />
                              {runMode === 'demo'
                                ? '同模型自检（仅真实运行适用）'
                                : '增加同一模型自检（共 2 次调用）'}
                            </label>
                          </>
                        )}
                        <label>
                          输入范围
                          <select
                            aria-label="输入范围"
                            value={method === 'S5' ? 'continue' : context}
                            disabled={!!active || method === 'S5' || runMode === 'demo'}
                            onChange={(e) =>
                              setContext(e.target.value as 'continue' | 'source_only')
                            }
                          >
                            <option value="continue">当前方案、参考材料与最近讨论</option>
                            <option value="source_only">只看原材料，建立新分支</option>
                          </select>
                        </label>
                        {context === 'source_only' && method !== 'S5' && (
                          <p>
                            独立阶段不读旧稿和旧讨论；目标、确认约束、参考材料仍可见。S1
                            最后比较步骤显式读取当前成果与候选。
                          </p>
                        )}
                        <label>
                          可选金额上限（USD）
                          <input
                            aria-label="可选金额上限"
                            type="number"
                            min="0.001"
                            step="0.01"
                            value={budget}
                            onChange={(e) => setBudget(e.target.value)}
                            disabled={!!active || runMode === 'demo'}
                            placeholder="不设置"
                          />
                        </label>
                        <p>
                          {runMode === 'demo' ? '合成预置演示 · 0 次模型调用。' : method + ' · '}
                          {runMode === 'demo'
                            ? '本模式只展示预设问题，不模拟不同策略效果。'
                            : method === 'S0'
                              ? '一个连接回答，可选同连接自检。'
                              : method === 'S1'
                                ? 'A/B 分别提案，由选定角色最终比较，总共三次。'
                                : 'A 核对材料，B 复核，两次调用。'}
                          不联网，不以模型一致认定事实。
                        </p>
                        <p>
                          真实调用按供应商价格计费。金额上限需已配置单价，不能代替供应商账单限额；失败或取消也可能计费，不自动重试。
                        </p>
                      </details>
                    </div>
                  </details>
                </div>
                <button
                  className="cg-secondary cg-export"
                  onClick={() => open('export')}
                  disabled={!!dirty}
                >
                  <Download size={16} />
                  导出
                </button>
              </div>
              {runMode === 'live' && (
                <div className="cg-role-controls">
                  <label>
                    {method === 'S0'
                      ? '使用连接'
                      : method === 'S5'
                        ? '初审连接（A）'
                        : '提案连接（A）'}
                    <select
                      aria-label="主要连接"
                      disabled={!!active}
                      value={primary}
                      onChange={(e) => {
                        setPrimary(e.target.value);
                        rememberSelection({ a: e.target.value });
                      }}
                    >
                      {connectionOptions(primary)}
                    </select>
                  </label>
                  {method !== 'S0' && (
                    <label>
                      {method === 'S5' ? '复核连接（B）' : '提案连接（B）'}
                      <select
                        aria-label="协作连接"
                        disabled={!!active}
                        value={secondary}
                        onChange={(e) => {
                          setSecondary(e.target.value);
                          rememberSelection({ b: e.target.value });
                        }}
                      >
                        {connectionOptions(secondary)}
                      </select>
                    </label>
                  )}
                  {method === 'S1' && (
                    <label>
                      最终比较
                      <select
                        aria-label="最终比较角色"
                        disabled={!!active}
                        value={compareRole}
                        onChange={(e) => {
                          setCompareRole(e.target.value as 'a' | 'b');
                          rememberSelection({ compareRole: e.target.value as 'a' | 'b' });
                        }}
                      >
                        <option value="a">由 A 负责</option>
                        <option value="b">由 B 负责</option>
                      </select>
                    </label>
                  )}
                  {method === 'S0' && (
                    <small>
                      自检{selfCheck ? '开启，仍使用同一连接' : '关闭'}；可在检查方式详情调整。
                    </small>
                  )}
                </div>
              )}
              <div className="cg-input-summary" id="check-preview">
                {dirty && <b>编辑中，保存后可检查 / 采纳。</b>}
                {task.example && <span className="cg-tag">示例</span>}
                {runMode === 'demo' ? (
                  <>
                    <span className="cg-pill">预置问题体验</span>
                    <span className="cg-pill">0 次模型调用</span>
                    <span className="cg-pill">不计费</span>
                  </>
                ) : (
                  <>
                    <span className="cg-pill">
                      {task.example ? '示例资料发送至真实 API' : '真实运行'}
                    </span>
                    <span className="cg-pill">{calls} 次调用</span>
                    <span className="cg-pill">
                      {context === 'source_only' && method !== 'S5'
                        ? '仅原材料新分支'
                        : '当前方案＋' + task.sources.length + ' 份材料＋最近讨论'}
                    </span>
                    <span className="cg-pill">
                      按量计费
                      {missing
                        ? ' · 请选择连接'
                        : workspace.connections.some(
                              (c) =>
                                chosenIds.includes(c.connectionId) &&
                                (c.inputPrice === null || c.outputPrice === null),
                            )
                          ? ' · 部分单价未知'
                          : ''}
                    </span>
                  </>
                )}
                {sameModel && runMode === 'live' && (
                  <span className="cg-selection-warning">
                    <AlertCircle size={14} />
                    {primary === secondary ? '两个角色使用同一个连接' : '两个连接的模型 ID 相同'}
                    ；不代表模型异构或观点独立。
                  </span>
                )}
              </div>
              {runMode === 'live' && (
                <div className="cg-preflight">
                  <span className={inputTooLarge ? 'cg-input-limit exceeded' : 'cg-input-limit'}>
                    <i style={{ width: Math.min(100, (inputBytes / inputLimit) * 100) + '%' }} />
                    <span
                      title={
                        '初始请求 ' +
                        inputBytes.toLocaleString() +
                        ' / ' +
                        inputLimit.toLocaleString() +
                        ' 字节'
                      }
                    >
                      上下文 {(inputBytes / 1000).toFixed(2)} KB / {inputLimit / 1000} KB
                    </span>
                  </span>
                  <small>
                    已计入请求包装
                    {inputBudget?.reserve
                      ? '；后续结果预留 ' + (inputBudget.reserve / 1000).toFixed(2) + ' KB'
                      : '；启动前服务端复核'}
                    。
                  </small>
                  {(missing || needsMaterials || inputTooLarge) && (
                    <span className="cg-blocked-reason">
                      <AlertCircle size={13} />
                      {inputTooLarge
                        ? '输入过大，请缩短材料或讨论。'
                        : missing
                          ? '检查前请选择已配置的连接。'
                          : '核对材料需要至少一份参考材料。'}
                    </span>
                  )}
                  {missing && (
                    <div className="cg-preflight-actions">
                      <button onClick={() => open('settings')}>配置连接</button>
                      <button onClick={sampleFlow}>
                        先看示例流程 <ArrowUpRight size={12} />
                      </button>
                    </div>
                  )}
                </div>
              )}
              {active && (
                <div className="cg-running" role="status">
                  <span>
                    <Loader2 size={16} className="spin" />
                    {runFeedback(active, task.findings).detail}
                  </span>
                  <button
                    className="cg-secondary"
                    disabled={busy}
                    onClick={() =>
                      action(
                        () => api('stop', { taskId: task.id, runId: active.id }),
                        '已停止后续步骤，已发请求仍可能计费。',
                      )
                    }
                  >
                    <Square size={13} />
                    停止
                  </button>
                </div>
              )}
            </section>
            <div
              className="cg-mobile-tabs"
              onKeyDown={(e) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                e.preventDefault();
                const next =
                  e.key === 'Home'
                    ? 'document'
                    : e.key === 'End'
                      ? 'suggestions'
                      : mobile === 'document'
                        ? 'suggestions'
                        : 'document';
                switchMobile(next);
                document
                  .getElementById(next === 'document' ? 'document-tab' : 'suggestions-tab')
                  ?.focus({ preventScroll: true });
              }}
              role="tablist"
              aria-label="工作视图"
            >
              <button
                id="document-tab"
                role="tab"
                tabIndex={mobile === 'document' ? 0 : -1}
                aria-controls="current-document"
                aria-selected={mobile === 'document'}
                onClick={() => switchMobile('document')}
              >
                方案
              </button>
              <button
                id="suggestions-tab"
                role="tab"
                tabIndex={mobile === 'suggestions' ? 0 : -1}
                aria-controls="suggestions-panel"
                aria-selected={mobile === 'suggestions'}
                onClick={() => switchMobile('suggestions')}
              >
                建议 <span>{pending}</span>
              </button>
            </div>
            <ReviewControls
              task={task}
              spec={reviewConfig}
              selectedIds={reviewSelection}
              disabled={!!active || busy}
              enabled={scopedReview}
              onChange={changeReviewConfig}
              onSelect={setReviewSelection}
            />
            <main className="cg-main" id="main-content" tabIndex={-1} data-mobile={mobile}>
              <section
                className="cg-document"
                id="current-document"
                tabIndex={-1}
                aria-label="当前方案"
              >
                <div className="cg-document-toolbar">
                  <span>
                    当前方案{' '}
                    <small>
                      <button className="cg-version-link" onClick={() => open('versions')}>
                        v{revision.number}
                      </button>{' '}
                      · {editing ? draftStatus : '已保存'}
                    </small>
                  </span>
                  <div>
                    {editing ? (
                      <>
                        <button
                          className="cg-text-button"
                          onClick={() => {
                            persistDraft();
                            setEditing(false);
                            setNotice(dirty ? '草稿已保留，可继续编辑。' : '已退出编辑。');
                          }}
                        >
                          结束编辑
                        </button>
                        <button
                          className="cg-primary"
                          onClick={save}
                          disabled={busy || !dirty || draftTooLong}
                        >
                          <Save size={15} />
                          保存
                        </button>
                      </>
                    ) : (
                      <button className="cg-text-button" onClick={edit}>
                        <Pencil size={15} />
                        编辑
                      </button>
                    )}
                  </div>
                </div>
                {editing && (
                  <div className={'cg-editor-count ' + (draftTooLong ? 'over-limit' : '')}>
                    全文 {draftLength.toLocaleString()} / 150,000 字符 · 每段上限 50,000
                    {draftTooLong ? ' · 请缩短超限内容' : ''}
                  </div>
                )}
                <article className="cg-paper">
                  {!editing && hasDraft && (
                    <div className="cg-draft-banner">
                      <span>有本机暂存草稿，尚未写入方案。{draftInfo}</span>
                      <button onClick={edit}>继续编辑</button>
                      <button
                        aria-label="清除暂存草稿"
                        onClick={() => {
                          if (
                            window.confirm('清除这个项目的浏览器暂存草稿？已保存方案不受影响。')
                          ) {
                            try {
                              localStorage.removeItem('cg-draft-' + task.id);
                            } catch {}
                            setHasDraft(false);
                          }
                        }}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  )}
                  {editing && draftBase !== revision.id && (
                    <div className="cg-alert warning">
                      当前草稿基于旧版本；保存会进行版本检查。请保留重要内容，不会自动覆盖新方案。
                    </div>
                  )}
                  <h2 className="cg-paper-title">
                    {task.title}
                    {task.example && <span className="cg-tag">合成示例</span>}
                  </h2>
                  {task.goal && <p className="cg-goal">{task.goal}</p>}
                  <section className="cg-constraints">
                    <b>目标与约束</b>
                    {editing ? (
                      <textarea
                        aria-label="编辑任务约束"
                        rows={3}
                        value={draftConstraint}
                        onChange={(e) => setDraftConstraint(e.target.value)}
                      />
                    ) : (
                      <p>{revision.constraint || '未设置硬约束，可在编辑中补充。'}</p>
                    )}
                  </section>
                  {(editing ? draft : revision.blocks).map((b, i) => {
                    const related = task.findings.filter(
                      (f) =>
                        !f.stale &&
                        f.blockId === b.id &&
                        (f.status === 'pending' || f.status === 'deferred'),
                    );
                    return (
                      <section key={b.id} className="cg-block" id={'block-' + b.id} tabIndex={-1}>
                        <header className="cg-block-heading">
                          {!/^\d+\s/.test(b.title) && (
                            <span className="cg-block-number">
                              {String(i + 1).padStart(2, '0')}
                            </span>
                          )}
                          {editing ? (
                            <input
                              aria-label={'段落 ' + (i + 1) + ' 标题'}
                              placeholder="段落标题（可选）"
                              maxLength={200}
                              value={b.title}
                              onChange={(e) =>
                                setDraft((old) =>
                                  old.map((x, j) =>
                                    i === j ? { ...x, title: e.target.value } : x,
                                  ),
                                )
                              }
                            />
                          ) : b.title ? (
                            <h2>{b.title}</h2>
                          ) : null}
                          {!editing && b.origin === 'ai' && (
                            <span className="cg-tag">已采纳修订</span>
                          )}
                          {!editing && (
                            <button
                              className="cg-text-button"
                              title="将此段设为审查范围"
                              disabled={!!active || busy}
                              onClick={() => {
                                changeReviewConfig({
                                  ...reviewConfig,
                                  mode: 'blocks',
                                  blockIds: [b.id],
                                  focus: '',
                                });
                                if (!reviewSelection.length)
                                  setReviewSelection(reviewConfig.criteria.map((c) => c.id));
                                setContext('continue');
                                const controls = document.getElementById(
                                  'review-controls',
                                ) as HTMLDetailsElement;
                                if (controls) {
                                  controls.open = true;
                                  controls.scrollIntoView({ block: 'center', behavior: 'instant' });
                                }
                              }}
                            >
                              <Search size={14} />
                              审查此段
                            </button>
                          )}
                          {!editing && !!related.length && (
                            <button
                              className="cg-block-findings"
                              onClick={() => {
                                setSelected(related[0].id);
                                setFilter('pending');
                                setMobile('suggestions');
                                requestAnimationFrame(() =>
                                  document
                                    .getElementById('card-' + related[0].id)
                                    ?.scrollIntoView({ block: 'center', behavior: 'instant' }),
                                );
                              }}
                            >
                              {related.length} 条建议
                            </button>
                          )}
                        </header>
                        {editing ? (
                          <>
                            <textarea
                              aria-label={'编辑 ' + (b.title || '段落 ' + (i + 1))}
                              rows={Math.max(4, Math.ceil(b.content.length / 38))}
                              value={b.content}
                              onChange={(e) =>
                                setDraft((old) =>
                                  old.map((x, j) =>
                                    i === j ? { ...x, content: e.target.value } : x,
                                  ),
                                )
                              }
                            />
                            <div className="cg-block-edit-actions">
                              <small
                                className={
                                  b.content.length > MAX_BLOCK_CHARACTERS ? 'over-limit' : ''
                                }
                              >
                                {b.content.length.toLocaleString()} / 50,000 字符
                              </small>
                              <button
                                className="cg-text-button"
                                disabled={draft.length >= 100}
                                onClick={() =>
                                  setDraft((old) => [
                                    ...old.slice(0, i + 1),
                                    {
                                      id: crypto.randomUUID(),
                                      title: '',
                                      content: '',
                                      origin: 'user',
                                    },
                                    ...old.slice(i + 1),
                                  ])
                                }
                              >
                                在下方新增段落
                              </button>
                              {draft.length > 1 && (
                                <button
                                  className="cg-text-button"
                                  onClick={() => {
                                    if (window.confirm('删除这一段？保存后仍可从版本历史恢复。'))
                                      setDraft((old) => old.filter((x) => x.id !== b.id));
                                  }}
                                >
                                  删除段落
                                </button>
                              )}
                              {i > 0 && (
                                <button
                                  className="cg-text-button"
                                  onClick={() =>
                                    setDraft((old) =>
                                      old.flatMap((x, j) =>
                                        j === i
                                          ? []
                                          : j === i - 1
                                            ? [
                                                {
                                                  ...x,
                                                  content:
                                                    x.content +
                                                    '\n\n' +
                                                    (b.title ? b.title + '\n' : '') +
                                                    b.content,
                                                  origin: 'user' as const,
                                                },
                                              ]
                                            : [x],
                                      ),
                                    )
                                  }
                                >
                                  合并到上一段
                                </button>
                              )}
                            </div>
                          </>
                        ) : (
                          <div>
                            <Highlight
                              text={b.content}
                              quote={
                                finding?.blockId === b.id &&
                                (finding.status === 'pending' || finding.status === 'deferred')
                                  ? finding.before
                                  : undefined
                              }
                            />
                          </div>
                        )}
                      </section>
                    );
                  })}
                </article>
                <footer className="cg-paper-note">
                  修改由你决定 · 保存、采纳和恢复都会保留版本
                </footer>
              </section>
              <aside id="suggestions-panel" className="cg-results" aria-label="检查结果与修改建议">
                <header>
                  <h2>
                    修改建议{' '}
                    <span>
                      {pending} 条待处理（含暂缓{' '}
                      {task.findings.filter((f) => !f.stale && f.status === 'deferred').length} 条）
                    </span>
                  </h2>
                  <select
                    aria-label="建议范围"
                    value={filter}
                    onChange={(e) => {
                      setFilter(e.target.value as typeof filter);
                      setSelected(null);
                    }}
                  >
                    <option value="pending">待处理（含暂缓）</option>
                    <option value="stale">需重查（{staleCount}）</option>
                    <option value="resolved">已处理</option>
                    <option value="all">全部记录</option>
                  </select>
                </header>
                <div className="cg-results-scroll">
                  <AssessmentPanel
                    task={task}
                    mode={runMode}
                    spec={reviewSpec}
                    disabled={!!active || busy || dirty}
                    onPrepare={(spec) => {
                      const prepared = prepareCriterionReview(reviewConfig, spec);
                      if (!prepared) {
                        setError('已配置 6 个验收项，请先移除一个再载入此项；现有设置已保留。');
                        return;
                      }
                      changeReviewConfig(prepared);
                      setReviewSelection(spec.criteria.map((c) => c.id));
                      setContext('continue');
                      setNotice('已载入该项的范围与标准；确认连接后点击“开始检查”。');
                      const controls = document.getElementById(
                        'review-controls',
                      ) as HTMLDetailsElement;
                      if (controls) {
                        controls.open = true;
                        controls.scrollIntoView({ block: 'center', behavior: 'instant' });
                      }
                    }}
                    onEvidence={(blockId, sourceId) => {
                      if (sourceId) {
                        setSourceId(sourceId);
                        open('materials');
                      } else {
                        setMobile('document');
                        requestAnimationFrame(() =>
                          document
                            .getElementById('block-' + blockId)
                            ?.scrollIntoView({ block: 'center', behavior: 'instant' }),
                        );
                      }
                    }}
                  />
                  {latest &&
                    latest.state !== 'running' &&
                    (() => {
                      const feedback = runFeedback(latest, task.findings);
                      return (
                        <div
                          key={latest.id + latest.state}
                          role="status"
                          aria-live="polite"
                          className={'cg-result-banner ' + feedback.tone}
                        >
                          <b>{feedback.title}</b>
                          <p>{feedback.detail}</p>
                          {['failed', 'partial', 'interrupted', 'cancelled'].includes(
                            latest.state,
                          ) && <button onClick={() => open('activity')}>查看调用记录与原因</button>}
                          {latest.summary && (
                            <details>
                              <summary>本次结论</summary>
                              <p>{latest.summary}</p>
                            </details>
                          )}
                        </div>
                      );
                    })()}
                  {runMode === 'live' && !active && (missing || needsMaterials) ? (
                    <div className="cg-guidance">
                      <Info size={17} />
                      <p>
                        {missing
                          ? '请在开始检查旁选择参与连接；原连接停用或删除后须重新选择，不会自动替换。'
                          : '核对材料需要至少一份参考材料。'}
                      </p>
                      <button onClick={() => open(missing ? 'settings' : 'materials')}>
                        {missing ? '管理 API 连接' : '添加材料'}
                      </button>
                      {missing && <button onClick={sampleFlow}>先看示例流程</button>}
                    </div>
                  ) : null}
                  {!task.findings.length && !latest && (
                    <div className="cg-results-empty">
                      <Search size={24} />
                      <h3>先检查，再决定修改</h3>
                      <p>
                        点击上方“开始检查”。建议会列出原文、拟修改内容和依据，接受后才会写入方案。
                      </p>
                    </div>
                  )}
                  {filteredFindings(task.findings, filter).map((f) => {
                    const reason = staleReason(task, f),
                      isOpen = selected === f.id;
                    return (
                      <section
                        className={'cg-finding ' + (isOpen ? 'open' : '')}
                        key={f.id}
                        id={'card-' + f.id}
                      >
                        <h3>
                          <button
                            className="cg-finding-summary"
                            aria-expanded={isOpen}
                            aria-controls={'finding-' + f.id}
                            aria-labelledby={'title-' + f.id}
                            onClick={() => {
                              setSelected(isOpen ? null : f.id);
                              if (!isOpen)
                                requestAnimationFrame(() => {
                                  const scroll = document.querySelector('.cg-results-scroll');
                                  const card = document.getElementById('card-' + f.id);
                                  if (scroll && card)
                                    scroll.scrollTop +=
                                      card.getBoundingClientRect().top -
                                      scroll.getBoundingClientRect().top;
                                  if (window.matchMedia('(min-width:961px)').matches)
                                    showBlock(f, false);
                                });
                            }}
                          >
                            <span className={'cg-priority ' + f.severity}>
                              {f.severity === 'high'
                                ? '优先处理'
                                : f.severity === 'medium'
                                  ? '建议检查'
                                  : '可选改进'}
                            </span>
                            <span className="cg-finding-title" id={'title-' + f.id}>
                              {f.title}
                            </span>
                            <span className="cg-finding-reason">{firstSentence(f.reason)}</span>
                            {(f.stale || f.status !== 'pending') && (
                              <small>
                                {f.supersededBy
                                  ? '已由新审查替代'
                                  : f.stale
                                    ? '已过期 · 需重查'
                                    : stateNames[f.status]}
                              </small>
                            )}
                            <ChevronDown size={16} />
                          </button>
                        </h3>
                        {isOpen && (
                          <div className="cg-finding-body" id={'finding-' + f.id}>
                            <button className="cg-text-button" onClick={() => showBlock(f)}>
                              在方案中查看
                            </button>
                            {f.status !== 'accepted' && reason && (
                              <div className="cg-alert warning">{reason}</div>
                            )}
                            <Diff before={f.before} after={f.after} />
                            <h4>为什么修改</h4>
                            <p>{f.reason}</p>
                            <details className="cg-evidence">
                              <summary>
                                <span>
                                  <BookOpen size={14} />
                                  材料依据
                                </span>
                                <small>
                                  {
                                    {
                                      supports: '材料支持',
                                      contradicts: '材料矛盾',
                                      insufficient: '依据不足',
                                    }[f.relation]
                                  }
                                </small>
                                <ChevronDown size={14} />
                              </summary>
                              {f.quote ? (
                                <blockquote>{f.quote}</blockquote>
                              ) : (
                                <p>未提供原始引用，需要人工核对。</p>
                              )}
                              <p className="cg-citation-status">
                                <Link2 size={13} />
                                {f.quoteValid ? '引用可定位' : '引用尚未定位'}
                                {f.sourceId && (
                                  <button
                                    onClick={() => {
                                      setSourceId(f.sourceId);
                                      open('materials');
                                    }}
                                  >
                                    查看原文
                                  </button>
                                )}
                              </p>
                              <small>
                                引用可定位仅指找到原句，不表示事实已经验证；支持关系仍需核对。
                              </small>
                            </details>
                          </div>
                        )}
                      </section>
                    );
                  })}
                  {filter === 'stale' && !!staleCount && (
                    <div className="cg-guidance">
                      <Info size={16} />
                      <p>正文或依据已变化，旧建议保留供回看。重新检查会生成当前版本的建议。</p>
                      <button disabled={!!runBlocked} onClick={start}>
                        重新检查
                      </button>
                    </div>
                  )}
                  {!!task.findings.length && !filteredFindings(task.findings, filter).length && (
                    <p className="cg-empty-note">
                      这个分类暂无建议。可以切换到“全部记录”回看已处理内容。
                    </p>
                  )}
                </div>
                {finding &&
                  filteredFindings(task.findings, filter).some((f) => f.id === finding.id) && (
                    <footer className="cg-result-actions" aria-label="建议操作">
                      <small>{finding.title}</small>
                      {dirty && <p>编辑中，请保存后再处理建议。</p>}
                      {finding.status !== 'accepted' && staleReason(task, finding) && (
                        <p>{staleReason(task, finding)}</p>
                      )}
                      {finding.status === 'accepted' ? (
                        <div className="cg-accepted">
                          已接受，保存为 v
                          {task.revisions.find((r) => r.id === finding.appliedRevision)?.number ??
                            '?'}
                          ，原版本保留。
                        </div>
                      ) : (
                        <>
                          <button
                            className="cg-primary cg-accept"
                            onClick={() => decide(finding, 'accepted')}
                            disabled={
                              busy ||
                              !!staleReason(task, finding) ||
                              finding.status === 'rejected' ||
                              !!dirty
                            }
                          >
                            接受修改
                          </button>
                          <div className="cg-decisions">
                            <button
                              onClick={() =>
                                decide(
                                  finding,
                                  finding.status === 'deferred' || finding.status === 'rejected'
                                    ? 'pending'
                                    : 'deferred',
                                )
                              }
                              disabled={busy || !!dirty}
                            >
                              {finding.status === 'deferred' || finding.status === 'rejected'
                                ? '恢复待处理'
                                : '暂缓'}
                            </button>
                            <button
                              onClick={() => decide(finding, 'rejected')}
                              disabled={busy || !!dirty || finding.status === 'rejected'}
                            >
                              拒绝
                            </button>
                          </div>
                        </>
                      )}
                    </footer>
                  )}
              </aside>
            </main>
          </>
        )
      )}
      {error && !drawer && (
        <div className="cg-error" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
          <button aria-label="关闭错误提示" onClick={() => setError('')}>
            <X size={18} />
          </button>
        </div>
      )}
      {notice && (
        <div className="cg-toast" role="status">
          {notice}
          <button aria-label="关闭提示" onClick={() => setNotice('')}>
            <X size={16} />
          </button>
        </div>
      )}
      {offline && (
        <div className="cg-offline">
          连接暂时中断，正文草稿仍保留。<button onClick={load}>重试连接</button>
        </div>
      )}
      <input
        ref={fileInput}
        hidden
        tabIndex={-1}
        type="file"
        accept=".txt,.md,.docx"
        aria-label="上传参考材料"
        onChange={(e) => {
          if (e.target.files?.[0]) upload(e.target.files[0]);
        }}
      />
      <input
        ref={draftInput}
        hidden
        tabIndex={-1}
        type="file"
        accept=".txt,.md"
        aria-label="上传方案原稿"
        onChange={(e) => {
          if (e.target.files?.[0]) importDraft(e.target.files[0]);
          e.target.value = '';
        }}
      />
      <Sheet
        open={!!drawer}
        title={drawer ? titles[drawer] : ''}
        onClose={() => setDrawer(null)}
        returnFocus={drawerFocus.current}
        wide={drawer === 'settings'}
      >
        {error && (
          <div className="cg-alert error" role="alert">
            {error}
            <button className="cg-text-button" onClick={() => setError('')}>
              关闭提示
            </button>
          </div>
        )}
        {drawer === 'new' && (
          <form
            className="cg-form"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <p>
              粘贴已有方案，或从文本文件导入。检查需配置 API
              连接；也可先体验示例。导入、编辑与导出无需 Key，后续修改保留版本。
            </p>
            <label>
              项目名称
              <input
                aria-label="项目名称"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                required
              />
            </label>
            <div className="cg-form-row">
              <b>方案正文</b>
              <button
                type="button"
                className="cg-secondary"
                onClick={() => draftInput.current?.click()}
              >
                <Upload size={15} />
                选择 TXT / Markdown
              </button>
            </div>
            <textarea
              aria-label="方案原稿"
              rows={10}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={50000}
              placeholder="把方案粘贴在这里…"
              required
            />
            <details className="cg-extra">
              <summary>补充目标与约束（可选）</summary>
              <label>
                希望重点检查什么
                <input value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={4000} />
              </label>
              <label>
                已确认的硬约束
                <textarea
                  aria-label="新项目约束"
                  rows={3}
                  value={constraint}
                  onChange={(e) => setConstraint(e.target.value)}
                  maxLength={4000}
                />
              </label>
            </details>
            <button className="cg-primary" disabled={busy || !title.trim() || !content.trim()}>
              <FileText size={16} />
              导入并打开
            </button>
          </form>
        )}
        {drawer === 'projects' && (
          <div className="cg-form">
            <p>
              移到回收站可释放项目名额，正文、历史、讨论与调用记录保留。最多同时保留 50
              个使用中的项目。
            </p>
            {workspace?.tasks.map((t) => (
              <section key={t.id}>
                <h3>{t.title}</h3>
                {renameId === t.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      action(
                        () =>
                          api('task/rename', {
                            taskId: t.id,
                            title: renameTitle,
                            base: t.currentRevision,
                          }),
                        '名称已更新。',
                      ).then((ok) => {
                        if (ok) setRenameId('');
                      });
                    }}
                  >
                    <label>
                      新项目名称
                      <input
                        aria-label="新项目名称"
                        maxLength={120}
                        required
                        value={renameTitle}
                        onChange={(e) => setRenameTitle(e.target.value)}
                      />
                    </label>
                    <button className="cg-secondary" disabled={busy || !renameTitle.trim()}>
                      保存名称
                    </button>
                  </form>
                ) : (
                  <button
                    className="cg-text-button"
                    disabled={busy || t.runs.some((r) => r.state === 'running')}
                    onClick={() => {
                      setRenameId(t.id);
                      setRenameTitle(t.title);
                    }}
                  >
                    重命名
                  </button>
                )}{' '}
                <button
                  className="cg-text-button"
                  disabled={busy || t.runs.some((r) => r.state === 'running')}
                  onClick={() => archiveProject(t)}
                >
                  移到回收站
                </button>
              </section>
            ))}
            <h3>回收站</h3>
            {!workspace?.archivedTasks?.length && <p className="cg-muted">回收站为空。</p>}
            {workspace?.archivedTasks?.map((t) => (
              <section key={t.id}>
                <b>{t.title}</b>{' '}
                <button
                  className="cg-secondary"
                  disabled={busy}
                  onClick={() =>
                    action(() => api('task/restore', { taskId: t.id }), '项目及历史已恢复。')
                  }
                >
                  恢复项目
                </button>
              </section>
            ))}
          </div>
        )}
        {drawer === 'settings' && <ConnectionEditor embedded onSaved={load} />}
        {drawer === 'materials' && task && (
          <MaterialsDrawer
            task={task}
            busy={busy}
            source={source}
            finding={finding}
            setSourceId={setSourceId}
            setReplaceId={setReplaceId}
            onUpload={() => fileInput.current?.click()}
          />
        )}
        {drawer === 'export' && task && revision && (
          <div className="cg-form">
            <p>
              导出“{task.title}”当前已保存的 v{revision.number}。
            </p>
            <label>
              导出格式
              <select value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="docx">Word 文档（.docx）</option>
                <option value="md">Markdown（.md）</option>
              </select>
            </label>
            <label className="cg-checkbox">
              <input
                type="checkbox"
                checked={includeReview}
                onChange={(e) => setIncludeReview(e.target.checked)}
              />
              附带问题、引用与处理记录
            </label>
            <p className="cg-muted">不包含模型密钥、私有参数和完整讨论。未解决分歧可保留在附录。</p>
            <button className="cg-primary" disabled={!!dirty} onClick={download}>
              <Download size={16} />
              导出文件
            </button>
          </div>
        )}
        {drawer === 'versions' && task && revision && (
          <VersionsDrawer
            task={task}
            revision={revision}
            versionId={versionId}
            setVersionId={setVersionId}
            busy={busy}
            dirty={dirty}
            onRestore={(id) =>
              action(
                () => api('restore', { taskId: task.id, revision: id, base: revision.id }),
                '已从旧版创建新版本。',
              )
            }
            onActivity={() => open('activity')}
          />
        )}
        {drawer === 'activity' && task && (
          <>
            <p>实际输入、输出、失败与费用均保留；未知费用请与供应商账单核对。</p>
            {!task.runs.length && <p className="cg-muted">还没有调用记录。</p>}
            {task.runs
              .slice()
              .reverse()
              .map((r) => (
                <details key={r.id} className="cg-run-record">
                  <summary>
                    <b>{runFeedback(r, task.findings).title}</b>
                    <span>
                      {date(r.createdAt)} · {r.mode === 'demo' ? '合成示例' : r.strategy}
                    </span>
                  </summary>
                  <p>{r.summary || r.error || '运行尚无结论'}</p>
                  <p>
                    输入：{r.contextMode === 'source_only' ? '原材料分支' : '当前讨论'} · 基于 v
                    {task.revisions.find((v) => v.id === r.baseRevision)?.number ?? '?'}
                  </p>
                  {r.steps.map((s) => (
                    <section key={s.id}>
                      <h4>{s.label}</h4>
                      <p>
                        {s.status} · {s.connectionSnapshot?.label || '旧记录：连接名称未记录'} ·{' '}
                        {s.connectionSnapshot?.model || s.model || '模型未知／未调用'} ·{' '}
                        {s.connectionSnapshot?.protocol || '旧协议未记录'} · {money(s.cost)}
                      </p>
                      <p>
                        输入 {s.usage?.input ?? '未知'} / 输出 {s.usage?.output ?? '未知'} tokens
                      </p>
                      {s.error && <div className="cg-alert error">{s.error}</div>}
                      {s.result && <p>{s.result}</p>}
                      <JsonBlock value={s} />
                    </section>
                  ))}
                </details>
              ))}
          </>
        )}
        {drawer === 'impact' && task && (
          <>
            <p>
              仅检查明确段落变化和有限预算／日期规则。未发现关联不等于无影响，尚未实现全面语义依赖发现。
            </p>
            {!task.impacts.length && <p className="cg-muted">还没有条件或材料变更。</p>}
            {task.impacts.map((i) => (
              <section className="cg-impact" key={i.id}>
                <h3>{i.title}</h3>
                <b>
                  {
                    {
                      review: '需要复核',
                      possible: '可能相关',
                      unchecked: '尚未检查',
                      checked: '范围内未发现影响',
                    }[i.state]
                  }
                </b>
                <p>{i.reason}</p>
                <small>{i.rule}</small>
              </section>
            ))}
          </>
        )}
        {drawer === 'discussion' && task && (
          <DiscussionDrawer
            task={task}
            active={active}
            latest={latest}
            busy={busy}
            available={available}
            receiver={receiver}
            question={question}
            setReceiver={setReceiver}
            setQuestion={setQuestion}
            onRememberReceiver={(receiver) => rememberSelection({ receiver })}
            connectionOptions={connectionOptions}
            send={send}
            onStop={() =>
              active && action(() => api('stop', { taskId: task.id, runId: active.id }))
            }
            onActivity={() => open('activity')}
          />
        )}
        {drawer === 'help' && (
          <div className="cg-help">
            <ol>
              <li>
                <b>放入方案</b>
                <p>在顶部项目选择器新建项目，粘贴或导入原稿。当前方案一直在左侧。</p>
              </li>
              <li>
                <b>开始检查</b>
                <p>
                  选择检查方式，确认紧邻按钮显示的输入、次数与费用。示例只体验预置问题，真实任务先接入
                  API。
                </p>
              </li>
              <li>
                <b>看清再接受</b>
                <p>
                  打开建议，比较原文与修改；“查看原文”在抽屉中展示依据。引用可定位不代表事实已经验证。
                </p>
              </li>
              <li>
                <b>保存与导出</b>
                <p>接受后形成新版本；上方“导出”带走成果。历史、讨论和调用记录都在“更多”。</p>
              </li>
            </ol>
            <h3>规划中的方式</h3>
            <p>
              交叉辩论、受 SEIMAD 启发的苏格拉底式审查及合作性对抗规则组合尚未实现，不是已验证能力。
            </p>
            <p>
              当前为本机单用户初版，尚未提供联网检索、多人协作和全面语义依赖发现。模型一致、引用存在或用户接受，都不等于事实已验证。
            </p>
          </div>
        )}
        {drawer === 'sample' && (
          <>
            <p className="cg-tag">只读合成示例 · 不调用模型，不保存到工作区</p>
            {seed().tasks[0].revisions[0].blocks.map((b) => (
              <section className="cg-block" key={b.id}>
                <h3>{b.title}</h3>
                <p>{b.content}</p>
              </section>
            ))}
            <button className="cg-primary" onClick={() => open('new')}>
              导入我的方案
            </button>
          </>
        )}
      </Sheet>
    </div>
  );
}
