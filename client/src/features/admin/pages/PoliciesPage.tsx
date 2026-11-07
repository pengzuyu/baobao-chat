/**
 * PAD-09 策略中心（D10 阶段一务实版，路由 /admin/policies）两 tab：
 * - Agent 工具策略：只读 JSON 快照（v0.1 恒默认策略；agent_tool_policy 表阶段二）
 * - 敏感词库：分页列表 + 新增（word/category）+ 删除；写后消息域 3005 即时生效
 * - 六态：两 tab 独立 loading/empty/error；offline 只读（禁写）；forbidden 2003；
 *   degraded（新增冲突 9001 等写失败行内提示）
 */

import { useState } from 'react';
import { Bot, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { SkeletonBlock, SkeletonList } from '../../../shared/ui/Skeleton';
import { StateView, type ViewStateOrOk } from '../../../shared/ui/StateView';
import { useConnectionStore } from '../../../shared/store/connection';
import { useAddWord, useAgentPolicy, useDeleteWord, useWords } from '../api/hooks';

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

/** Agent 工具策略只读快照面板 */
function AgentPolicyPanel() {
  const query = useAgentPolicy();
  const connStatus = useConnectionStore((s) => s.status);
  const state: ViewStateOrOk = query.isPending
    ? 'loading'
    : query.isError
      ? query.error instanceof ApiError && query.error.code === 2003
        ? 'forbidden'
        : 'error'
      : connStatus === 'offline'
        ? 'offline'
        : 'ok';

  return (
    <StateView
      state={state}
      skeleton={<SkeletonBlock height={320} />}
      emptyText="策略快照为空"
      error={query.error}
      onRetry={() => void query.refetch()}
      forbiddenText="需要 admin:policy:manage 权限"
    >
      <section className="admin-panel">
        <div className="admin-panel__title">
          agent_tool_policy 快照
          <span className="admin-tag">{query.data?.source === 'table' ? '表数据' : '默认策略'}</span>
          <span className="admin-panel__meta">version {query.data?.version} · {query.data ? new Date(query.data.updated_at).toLocaleString('zh-CN') : ''}</span>
        </div>
        <pre className="admin-json" data-testid="admin-agent-policy-json">
          {JSON.stringify(query.data?.policy ?? {}, null, 2)}
        </pre>
        <div className="admin-panel__note">v0.1 只读展示（阶段二 agent_tool_policy 表落地后开放编辑与 agent.policy.updated 热更）</div>
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
        onError: (err) => setFormError(err instanceof ApiError ? getErrorText(err.code) : '新增失败'),
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
