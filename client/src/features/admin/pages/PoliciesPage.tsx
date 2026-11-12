/**
 * PAD-09 策略中心（D10 阶段一务实版，路由 /admin/policies）两 tab：
 * - Agent 工具策略：行级编辑（D7：agent_tool_policy upsert/删行回落默认）+ 合成快照 JSON
 * - 敏感词库：分页列表 + 新增（word/category）+ 删除；写后消息域 3005 即时生效
 * - 六态：两 tab 独立 loading/empty/error；offline 只读（禁写）；forbidden 2003；
 *   degraded（新增冲突 9001 等写失败行内提示）
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { ApiError, errText as apiErrText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { SkeletonBlock, SkeletonList } from '../../../shared/ui/Skeleton';
import { StateView, type ViewStateOrOk } from '../../../shared/ui/StateView';
import { useConnectionStore } from '../../../shared/store/connection';
import { useAddWord, useAgentPolicy, useDeleteWord, useWords } from '../api/hooks';
import { deleteAgentToolPolicy, updateAgentToolPolicy } from '../api/admin';

type TabKey = 'agent' | 'words';

export function PoliciesPage() {
  const [tab, setTab] = useState<TabKey>('agent');
  return (
    <div className="admin-policies">
      <header className="admin-page__header">
        <h2 className="admin-page__title">策略中心</h2>
        <span className="admin-page__meta">Agent 域只读快照 · 敏感词库读写（写后即时生效）</span>
      </header>
      <div className="admin-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'agent'} className={`admin-tab${tab === 'agent' ? ' admin-tab--active' : ''}`} onClick={() => setTab('agent')}>
          <Bot size={14} /> Agent 工具策略
        </button>
        <button type="button" role="tab" aria-selected={tab === 'words'} className={`admin-tab${tab === 'words' ? ' admin-tab--active' : ''}`} onClick={() => setTab('words')}>
          <ShieldAlert size={14} /> 敏感词库
        </button>
      </div>
      {tab === 'agent' ? <AgentPolicyPanel /> : <WordsPanel />}
    </div>
  );
}

/** 默认内置工具集（09 §5.2 defaultAgentPolicy 口径；编辑器首屏四行） */
const BUILTIN_SUBJECTS: Array<{ subject: string; label: string; defAllowed: boolean }> = [
  { subject: 'fs_read', label: '文件读取（fs_read）', defAllowed: true },
  { subject: 'fs_write', label: '文件写入（fs_write）', defAllowed: true },
  { subject: 'shell_exec', label: '命令执行（shell_exec）', defAllowed: false },
  { subject: 'http_fetch', label: '外网请求（http_fetch）', defAllowed: false },
];

/** Agent 工具策略面板（D7：行级编辑 + 快照 JSON） */
function AgentPolicyPanel() {
  const query = useAgentPolicy();
  const connStatus = useConnectionStore((s) => s.status);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [errText, setErrText] = useState('');
  const [newSubject, setNewSubject] = useState('');
  const [showJson, setShowJson] = useState(false);

  const state: ViewStateOrOk = query.isPending
    ? 'loading'
    : query.isError
      ? query.error instanceof ApiError && query.error.code === 2003
        ? 'forbidden'
        : 'error'
      : connStatus === 'offline'
        ? 'offline'
        : 'ok';

  const rows = query.data?.rows ?? [];
  const rowOf = (subject: string) => rows.find((r) => r.subject === subject);
  const extraRows = rows.filter((r) => !BUILTIN_SUBJECTS.some((b) => b.subject === r.subject));

  const apply = (p: Promise<unknown>, key: string) => {
    setBusy(key);
    setErrText('');
    void p
      .then(() => qc.invalidateQueries({ queryKey: ['admin', 'policy', 'agent'] }))
      .catch((e) => setErrText(apiErrText(e, '操作失败')))
      .finally(() => setBusy(null));
  };

  const toggle = (subject: string, defAllowed: boolean) => {
    const cur = rowOf(subject);
    const next = cur ? !cur.allowed : !defAllowed; // 无行=默认态 → 切为反向（落表）
    apply(updateAgentToolPolicy({ subject, allowed: next }), subject);
  };

  const addSubject = () => {
    const s = newSubject.trim();
    if (!s) return;
    apply(updateAgentToolPolicy({ subject: s, allowed: true }), s);
    setNewSubject('');
  };

  return (
    <StateView
      state={state}
      skeleton={<SkeletonBlock height={320} />}
      emptyText="策略快照为空"
      error={query.error}
      onRetry={() => void query.refetch()}
      forbiddenText="需要 admin:policy:manage 权限"
    >
      <section className="admin-panel" data-testid="admin-agent-policy-editor">
        <div className="admin-panel__title">
          agent_tool_policy
          <span className="admin-tag">{query.data?.source === 'table' ? '表数据' : '默认策略'}</span>
          <span className="admin-panel__meta">version {query.data?.version} · {query.data ? new Date(query.data.updated_at).toLocaleString('zh-CN') : ''}</span>
          <Button variant="secondary" onClick={() => setShowJson((v) => !v)} data-testid="admin-policy-json-toggle">
            {showJson ? '收起快照 JSON' : '查看快照 JSON'}
          </Button>
        </div>

        {errText ? <div className="admin-inline-error" data-testid="admin-policy-error">{errText}</div> : null}

        <div className="admin-policy-rows">
          {BUILTIN_SUBJECTS.map((b) => {
            const row = rowOf(b.subject);
            const allowed = row ? row.allowed : b.defAllowed;
            return (
              <div key={b.subject} className="admin-policy-row" data-testid={`admin-policy-row-${b.subject}`}>
                <span className="admin-policy-row__name">
                  {b.label}
                  {row ? <span className="admin-tag">已覆盖</span> : null}
                </span>
                <label className="admin-policy-row__switch">
                  <input
                    type="checkbox"
                    checked={allowed}
                    disabled={busy === b.subject || connStatus === 'offline'}
                    onChange={() => toggle(b.subject, b.defAllowed)}
                    data-testid={`admin-policy-toggle-${b.subject}`}
                  />
                  {allowed ? '允许' : '禁用'}
                </label>
                {row ? (
                  <Button variant="secondary" disabled={busy === b.subject} onClick={() => apply(deleteAgentToolPolicy(b.subject), b.subject)} title="删行回落默认">
                    恢复默认
                  </Button>
                ) : null}
              </div>
            );
          })}
          {extraRows.map((r) => (
            <div key={r.subject} className="admin-policy-row" data-testid={`admin-policy-row-${r.subject}`}>
              <span className="admin-policy-row__name">
                {r.subject}
                <span className="admin-tag">自定义</span>
              </span>
              <label className="admin-policy-row__switch">
                <input
                  type="checkbox"
                  checked={r.allowed}
                  disabled={busy === r.subject}
                  onChange={() => toggle(r.subject, true)}
                />
                {r.allowed ? '允许' : '禁用'}
              </label>
              <Button variant="secondary" disabled={busy === r.subject} onClick={() => apply(deleteAgentToolPolicy(r.subject), r.subject)}>
                恢复默认
              </Button>
            </div>
          ))}
        </div>

        <div className="admin-policy-add">
          <input
            placeholder="自定义 subject（如 app:crm:*）"
            value={newSubject}
            onChange={(e) => setNewSubject(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSubject()}
            data-testid="admin-policy-new-subject"
          />
          <Button onClick={addSubject} loading={!!newSubject.trim() && busy === newSubject.trim()} data-testid="admin-policy-add-btn">
            添加授权行
          </Button>
        </div>

        <div className="admin-panel__note">
          判定链（09 §4）：租户策略(本表) → 用户权限点 → 模式×工具矩阵 → 三级记忆 → untrusted 强制确认。
          热更事件 agent.policy.updated 与 bbrt 工具门面下发随 Agent 域阶段二接线。
        </div>

        {showJson ? (
          <pre className="admin-json" data-testid="admin-agent-policy-json">
            {JSON.stringify(query.data?.policy ?? {}, null, 2)}
          </pre>
        ) : null}
      </section>
    </StateView>
  );
}

/** 敏感词库面板（CRUD） */
function WordsPanel() {
  const query = useWords();
  const add = useAddWord();
  const del = useDeleteWord();
  const connStatus = useConnectionStore((s) => s.status);

  const [word, setWord] = useState('');
  const [category, setCategory] = useState('');
  const [formError, setFormError] = useState('');

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const lastPage = query.data?.pages[query.data.pages.length - 1];
  const state: ViewStateOrOk = query.isPending
    ? 'loading'
    : query.isError
      ? query.error instanceof ApiError && query.error.code === 2003
        ? 'forbidden'
        : 'error'
      : items.length === 0
        ? 'empty'
        : connStatus === 'offline'
          ? 'offline'
          : 'ok';

  const submit = () => {
    const w = word.trim();
    if (!w) {
      setFormError('敏感词不能为空');
      return;
    }
    setFormError('');
    add.mutate(
      { word: w, category: category.trim() || undefined },
      {
        onSuccess: () => setWord(''),
        onError: (err) => setFormError(apiErrText(err, '新增失败')),
      },
    );
  };

  return (
    <>
      {/* 新增表单恒渲染（空库时也能加首词——不随列表六态隐藏） */}
      <div className="admin-word-form admin-word-form--top">
        <input
          className="bbw-input admin-word-form__word"
          value={word}
          placeholder="新增敏感词（≤64 字，Enter 提交）"
          onChange={(e) => setWord(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          data-testid="admin-word-input"
        />
        <input className="bbw-input admin-word-form__category" value={category} placeholder="分类（可选）" onChange={(e) => setCategory(e.target.value)} />
        <Button onClick={submit} loading={add.isPending}>
          <Plus size={13} /> 新增
        </Button>
      </div>
      {formError ? (
        <div className="admin-error-bar" data-testid="admin-word-error">
          {formError}
        </div>
      ) : null}
      <StateView
        state={state}
        skeleton={<SkeletonList count={6} />}
        emptyText="词库为空（上方输入新增首词）"
        error={query.error}
        onRetry={() => void query.refetch()}
        forbiddenText="需要 admin:policy:manage 权限"
        offlineText="离线中：词库只读，新增/删除暂不可用"
      >
      <section className="admin-panel">
        <div className="admin-panel__title">
          敏感词库
          <span className="admin-panel__meta">共 {query.data?.pages[0]?.total ?? 0} 条 · mode=拦截（3005）· 写后消息域即时生效</span>
        </div>
        <table className="admin-table" data-testid="admin-words-table">
          <thead>
            <tr>
              <th>词</th>
              <th>分类</th>
              <th>模式</th>
              <th>添加时间</th>
              <th style={{ width: 90 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((w) => (
              <tr key={w.id} data-testid={`admin-word-${w.word}`}>
                <td className="admin-mono">{w.word}</td>
                <td>{w.category || '—'}</td>
                <td>{w.mode === 1 ? '拦截' : w.mode === 2 ? '替换' : '审计'}</td>
                <td className="admin-mono">{new Date(w.created_at).toLocaleString('zh-CN')}</td>
                <td>
                  <Button variant="danger" loading={del.isPending && del.variables === w.id} onClick={() => del.mutate(w.id)}>
                    <Trash2 size={13} /> 删除
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {lastPage?.has_more && lastPage.next_cursor ? (
          <div className="admin-loadmore">
            <Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              加载更多
            </Button>
          </div>
        ) : null}
      </section>
      </StateView>
    </>
  );
}
