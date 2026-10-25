'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  Plus,
  Pencil,
  Copy,
  Trash2,
  Power,
  Eye,
  EyeOff,
  Loader2,
  PlugZap,
  AlertCircle,
  Save,
} from 'lucide-react';
import type { PublicConnection, Connection, ConnectionTest } from '@/lib/types';
import { formatMoney } from '@/lib/presentation';
import { MAX_CONNECTIONS } from '@/lib/limits';
import { AppLink } from './site-header';
import { api as request } from '@/lib/client-api';
import { browserUUID } from '@/lib/browser-storage';
import { exportDate as stamp } from '@/lib/text';
type Draft = Omit<Connection, 'createdAt' | 'updatedAt'> & { hasKey: boolean; clearKey: boolean };
function publicDraft(c: PublicConnection): Draft {
  return {
    connectionId: c.connectionId,
    label: c.label,
    baseURL: c.baseURL,
    protocol: c.protocol,
    model: c.model,
    structured: c.structured,
    inputPrice: c.inputPrice,
    outputPrice: c.outputPrice,
    enabled: c.enabled,
    slot: c.slot,
    apiKey: '',
    hasKey: c.hasKey,
    clearKey: false,
  };
}
export default function ConnectionEditor({
  embedded = false,
  onSaved,
}: {
  embedded?: boolean;
  onSaved?: () => void;
}) {
  const [items, setItems] = useState<PublicConnection[]>([]),
    [draft, setDraft] = useState<Draft | null>(null),
    [baseline, setBaseline] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [testing, setTesting] = useState(''),
    [visible, setVisible] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [remove, setRemove] = useState(''),
    [probe, setProbe] = useState<ConnectionTest | null>(null);
  const dirty = !!draft && JSON.stringify(draft) !== baseline;
  const load = useCallback(async () => {
    try {
      setItems(await request('settings'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
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
      if (dirty && !window.confirm('连接修改尚未保存，是否放弃修改并切换页面？'))
        event.preventDefault();
    };
    window.addEventListener('cg-before-navigate', guard);
    return () => window.removeEventListener('cg-before-navigate', guard);
  }, [dirty]);
  // Sheet asks before closing, including Escape and genuine backdrop clicks.
  useEffect(() => {
    const sheet = document.querySelector<HTMLDialogElement>('.cg-sheet[open]');
    if (!dirty || !sheet) return;
    const prevent = (event: Event) => {
      if (!window.confirm('连接修改尚未保存，是否放弃修改并关闭？')) event.preventDefault();
    };
    sheet.addEventListener('cg-before-close', prevent);
    return () => sheet.removeEventListener('cg-before-close', prevent);
  }, [dirty]);
  function edit(c: PublicConnection) {
    if (dirty && !window.confirm('放弃本次未保存的连接修改？')) return;
    const next = publicDraft(c);
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setProbe(null);
    setVisible(false);
    setError('');
    setRemove('');
  }
  function add() {
    if (items.length >= MAX_CONNECTIONS) {
      setError(`最多保存 ${MAX_CONNECTIONS} 个连接，请删除不再需要的连接后新增。`);
      return;
    }
    const next: Draft = {
      connectionId: browserUUID(),
      label: '',
      baseURL: 'https://api.openai.com/v1',
      apiKey: '',
      model: '',
      protocol: 'responses',
      structured: true,
      inputPrice: null,
      outputPrice: null,
      enabled: true,
      hasKey: false,
      clearKey: false,
    };
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setError('');
    setProbe(null);
    setVisible(false);
  }
  function back() {
    if (dirty && !window.confirm('放弃本次未保存的连接修改？')) return;
    setDraft(null);
    setProbe(null);
    setError('');
    setVisible(false);
  }
  function update(p: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...p } : null));
    setProbe(null);
    setNotice('');
  }
  async function operation(path: string, body: unknown, message: string) {
    setBusy(true);
    setError('');
    try {
      setItems(await request(path, body));
      setNotice(message);
      onSaved?.();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!draft) return;
    if (
      await operation('connections/save', { connection: draft }, '连接已保存。没有发起模型调用。')
    ) {
      setDraft(null);
      setProbe(null);
      setVisible(false);
    }
  }
  async function test(c: Draft | PublicConnection) {
    if (testing) return;
    setTesting(c.connectionId);
    setError('');
    setNotice('');
    try {
      const result: ConnectionTest = await request('connections/test', {
        connection: 'apiKey' in c ? c : publicDraft(c),
        confirmCall: true,
      });
      setProbe(result);
      setNotice(result.warning || '所选连接本次测试通过；不代表模型质量或所有任务均可用。');
      await load();
    } catch (e) {
      setError(
        (e as Error).message + (/计费/.test((e as Error).message) ? '' : ' 已发送的请求可能计费。'),
      );
      await load();
    } finally {
      setTesting('');
    }
  }
  const editingExisting = items.some((c) => c.connectionId === draft?.connectionId);
  const Heading = embedded ? 'h2' : 'h1';
  return (
    <div className={'api-editor ' + (embedded ? 'embedded' : 'standalone')}>
      <div className="api-page-heading">
        <div>
          <Heading>
            {draft ? (editingExisting ? '编辑连接' : '新增连接') : '让合适的模型，加入协作。'}
          </Heading>
          <p>保存最多 {MAX_CONNECTIONS} 套 API 配置，供文稿检查和 AI 协作按角色选择。</p>
        </div>
        {!embedded && (
          <AppLink className="cg-secondary" href="/agents">
            <ArrowLeft size={16} />
            返回 AI 协作
          </AppLink>
        )}
      </div>
      {items.some((c) => c.testLogWarning) && (
        <div role="status" className="api-feedback">
          {items.find((c) => c.testLogWarning)?.testLogWarning}
        </div>
      )}
      {error && (
        <div className="api-feedback error" role="alert">
          <AlertCircle size={17} />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="api-feedback" role="status">
          {notice}
        </div>
      )}
      {loading ? (
        <p>
          <Loader2 className="spin" size={16} /> 读取配置…
        </p>
      ) : draft ? (
        <form
          className="api-edit-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <button type="button" className="cg-text-button" onClick={back}>
            <ArrowLeft size={16} />
            返回连接列表
          </button>
          <p className="api-edit-note">
            {editingExisting
              ? '修改仅用于后续运行，已经启动的运行继续使用原配置。'
              : '新连接使用独立 ID；名称和模型 ID 不作为唯一身份。'}
            密钥留在本机服务端。
          </p>
          <fieldset disabled={busy || !!testing}>
            <label>
              连接名称
              <input
                aria-label="连接名称"
                value={draft.label}
                required
                maxLength={60}
                placeholder="例如：日常检查"
                onChange={(e) => update({ label: e.target.value })}
              />
            </label>
            <label>
              API 基础地址
              <input
                aria-label="API 基础地址"
                type="url"
                autoComplete="off"
                required
                value={draft.baseURL}
                onChange={(e) => update({ baseURL: e.target.value })}
              />
              <small>填写 Base URL，不附加 /responses 或 /chat/completions。</small>
            </label>
            <label>
              接口协议
              <select
                aria-label="接口协议"
                value={draft.protocol}
                onChange={(e) => update({ protocol: e.target.value as Connection['protocol'] })}
              >
                <option value="responses">OpenAI Responses API</option>
                <option value="chat">Chat Completions 兼容接口</option>
              </select>
            </label>
            <label>
              模型 ID
              <input
                aria-label="模型 ID"
                autoComplete="off"
                value={draft.model}
                placeholder="服务商提供的准确模型 ID"
                onChange={(e) => update({ model: e.target.value })}
              />
            </label>
            <div className="api-secret-field">
              <label htmlFor="connection-api-key">API Key</label>
              <span className="api-secret-input">
                <input
                  id="connection-api-key"
                  aria-label="API Key"
                  autoComplete="off"
                  type={visible ? 'text' : 'password'}
                  disabled={draft.clearKey}
                  value={draft.apiKey}
                  placeholder={draft.hasKey ? '已保存 · 留空保留' : '填写 API 密钥'}
                  onChange={(e) => update({ apiKey: e.target.value })}
                />
                <button
                  type="button"
                  aria-label={visible ? '隐藏密钥' : '显示密钥'}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </span>
              <small>已保存密钥不回传页面；更改地址须重新填写或清除密钥。</small>
            </div>
            {draft.hasKey && (
              <label className="api-check">
                <input
                  type="checkbox"
                  checked={draft.clearKey}
                  onChange={(e) => update({ clearKey: e.target.checked })}
                />
                清除已保存密钥
              </label>
            )}
            <label className="api-check">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
              />
              启用此连接供任务选择
            </label>
            <details className="api-advanced">
              <summary>结构化输出与可选价格</summary>
              <label className="api-check">
                <input
                  type="checkbox"
                  checked={draft.structured}
                  onChange={(e) => update({ structured: e.target.checked })}
                />
                接口支持严格 JSON Schema
              </label>
              <p>不支持时可取消；仍在服务端校验结果。</p>
              <div className="api-prices">
                {(['inputPrice', 'outputPrice'] as const).map((key) => (
                  <label key={key}>
                    {key === 'inputPrice' ? '输入' : '输出'}价格
                    <input
                      aria-label={key === 'inputPrice' ? '输入价格' : '输出价格'}
                      type="number"
                      min="0"
                      max="100000"
                      step="any"
                      value={draft[key] ?? ''}
                      onChange={(e) =>
                        update({ [key]: e.target.value === '' ? null : Number(e.target.value) })
                      }
                    />
                    <small>USD / 百万 token，留空为未知</small>
                  </label>
                ))}
              </div>
            </details>
          </fieldset>
          <p className="api-test-note">
            测试仅发 1 次请求，可能计费；不含项目材料，最多 256 输出 tokens、等待 30
            秒，不自动保存或重试。
          </p>
          {probe && (
            <p className="api-feedback">
              测试通过 · {probe.model} · {stamp(probe.startedAt)} · 输入 {probe.input ?? '未知'} /
              输出 {probe.output ?? '未知'} ·{' '}
              {probe.cost === null ? formatMoney(null) : `估算 ${formatMoney(probe.cost)}`}
            </p>
          )}
          <div className="api-edit-actions">
            <button
              className="cg-primary"
              type="submit"
              disabled={busy || !!testing || !draft.label.trim()}
            >
              <Save size={16} />
              保存 API 配置
            </button>
            <button
              className="cg-secondary"
              type="button"
              disabled={
                busy ||
                !!testing ||
                !draft.enabled ||
                !draft.model ||
                draft.clearKey ||
                (!draft.apiKey && !draft.hasKey)
              }
              onClick={() => test(draft)}
            >
              {testing ? <Loader2 size={16} className="spin" /> : <PlugZap size={16} />}
              测试连接（可能计费）
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="api-list-toolbar">
            <b>
              {items.length} / {MAX_CONNECTIONS} 个已保存连接
            </b>
            <button
              className="cg-primary"
              onClick={add}
              disabled={busy || !!testing || items.length >= MAX_CONNECTIONS}
            >
              <Plus size={16} />
              新增连接
            </button>
          </div>
          {items.length >= MAX_CONNECTIONS && (
            <p className="api-limit">
              已达到 {MAX_CONNECTIONS} 个连接上限；停用仍占名额，删除后可新增。
            </p>
          )}
          <div className="api-connection-list">
            {items.map((c) => (
              <section
                className="api-connection-row"
                key={c.connectionId}
                aria-label={c.label + ' 连接'}
              >
                <div className="api-row-title">
                  <h2>{c.label}</h2>
                  <span className="cg-tag">{c.enabled ? '已启用' : '已停用'}</span>
                  <span className="api-config-state">{c.configured ? '已配置' : '待配置'}</span>
                </div>
                <p className="api-row-model">{c.model || '未填写模型 ID'}</p>
                <p className="api-row-address">{c.baseURL}</p>
                <p className="api-test-state">
                  {c.lastTest
                    ? `${c.lastTest.success ? '测试通过' : '测试失败'} · ${stamp(c.lastTest.startedAt)} · ${c.lastTest.model}`
                    : '未测试当前配置'}
                  {c.inUse ? ' · 正在运行／测试' : ''}
                </p>
                <div className="api-row-actions">
                  <button onClick={() => edit(c)} disabled={busy || !!testing}>
                    <Pencil size={14} />
                    编辑
                  </button>
                  <button
                    onClick={() => test(c)}
                    disabled={busy || !!testing || !c.enabled || !c.configured}
                  >
                    <PlugZap size={14} />
                    {testing === c.connectionId ? '正在测试…' : '测试（可能计费）'}
                  </button>
                  <button
                    disabled={busy || !!testing || items.length >= MAX_CONNECTIONS}
                    onClick={() =>
                      operation(
                        'connections/copy',
                        { connectionId: c.connectionId },
                        '已复制非敏感配置，未复制密钥。',
                      )
                    }
                  >
                    <Copy size={14} />
                    复制
                  </button>
                  <button
                    disabled={busy || !!testing}
                    onClick={() =>
                      operation(
                        'connections/save',
                        { connection: { ...publicDraft(c), enabled: !c.enabled } },
                        c.enabled ? '已停用，请在后续任务中重新选择可用连接。' : '已启用连接。',
                      )
                    }
                  >
                    <Power size={14} />
                    {c.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    disabled={busy || !!testing || c.inUse}
                    title={c.inUse ? '运行或测试中的连接不能删除' : undefined}
                    onClick={() => setRemove(c.connectionId)}
                  >
                    <Trash2 size={14} />
                    删除
                  </button>
                </div>
                {remove === c.connectionId && (
                  <div className="api-delete-confirm">
                    <p>删除“{c.label}”及其密钥？历史结果与版本保留。需要再次使用时须重新配置。</p>
                    <button
                      className="cg-secondary"
                      disabled={busy}
                      onClick={async () => {
                        if (
                          await operation(
                            'connections/delete',
                            { connectionId: c.connectionId },
                            '连接已删除，历史记录保留。',
                          )
                        )
                          setRemove('');
                      }}
                    >
                      确认删除连接
                    </button>
                    <button className="cg-text-button" onClick={() => setRemove('')}>
                      取消
                    </button>
                  </div>
                )}
              </section>
            ))}
          </div>
          {!items.length && (
            <section className="api-empty">
              <PlugZap size={28} />
              <h2>从第一个模型连接开始</h2>
              <p>填入供应商地址、模型 ID 和 API Key，保存后即可分配角色。</p>
              <button className="cg-secondary" onClick={add}>
                <Plus size={16} />
                添加模型连接
              </button>
              <small>保存配置不会调用模型。</small>
            </section>
          )}
        </>
      )}
      <p className="api-privacy">
        配置与密钥保存在这台电脑的服务端文件中，未加应用级加密。网页会员不能代替 API
        凭据。测试通过只说明本次接口与返回可用；不代表模型质量。保存或复制不会调用模型，复制不携带密钥。
      </p>
    </div>
  );
}
