/**
 * PAG-11 三级记忆管理页（/agent/memory，D08 §3.11 / D15 §2.1）：
 * - 知识记忆条目列表：标题 / type 徽标 / 钩子摘要 / updated_at / 来源会话
 * - 类型筛选四类：用户偏好 user / 项目事实 project / 工作反馈 feedback / 外部参考 reference
 * - 撤销（删除）即时生效；空态分"全库空"与"该类型无条目"
 * - 六态：loading/empty/error/offline（mock 桥本地无网照常）；forbidden 不适用（本域无独立权限点，准入由 /agent 页面统一）
 */

import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { useConnectionStore } from '../../../shared/store/connection';
import { useAgentStore } from '../store/agent';
import { MEMORY_TYPE_LABELS } from '../bridge/types';
import type { MemoryType } from '../bridge/types';
import { AgentSubNav } from '../components/AgentSubNav';

type Filter = 'all' | MemoryType;

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'user', label: '用户偏好' },
  { value: 'project', label: '项目事实' },
  { value: 'feedback', label: '工作反馈' },
  { value: 'reference', label: '外部参考' },
];

function formatDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function AgentMemoryPage() {
  const init = useAgentStore((s) => s.init);
  const memories = useAgentStore((s) => s.memories);
  const loading = useAgentStore((s) => s.memoriesLoading);
  const error = useAgentStore((s) => s.memoriesError);
  const deleteMemory = useAgentStore((s) => s.deleteMemory);
  const sessions = useAgentStore((s) => s.sessions);

  const [filter, setFilter] = useState<Filter>('all');

  // 页面直达也确保装载（工作台可能未访问过；init 内部有 ready 守卫）
  useEffect(() => {
    void init();
  }, [init]);

  const connStatus = useConnectionStore((s) => s.status);
  const degradedText = useConnectionStore((s) => s.degradedText);

  const filtered = useMemo(() => (filter === 'all' ? memories : memories.filter((m) => m.type === filter)), [memories, filter]);

  const state: ViewState | 'ok' = loading
    ? 'loading'
    : error
      ? 'error'
      : memories.length === 0
        ? 'empty'
        : filtered.length === 0
          ? 'empty'
          : degradedText
            ? 'degraded'
            : connStatus === 'offline'
              ? 'offline'
              : 'ok';

  const listNode = (
    <div className="agent-mem-list">
      {filtered.map((m) => {
        const source = sessions.find((s) => s.id === m.sessionId);
        return (
          <div key={m.name} className="agent-mem-item" data-memory-name={m.name}>
            <div className="agent-mem-item__main">
              <div className="agent-mem-item__title-row">
                <span className={`agent-mem-chip agent-mem-chip--${m.type}`}>{MEMORY_TYPE_LABELS[m.type]}</span>
                <span className="agent-mem-item__title">{m.title}</span>
              </div>
              <div className="agent-mem-item__hook">{m.hook}</div>
              <div className="agent-mem-item__meta">
                更新 {formatDay(m.updatedAt)}
                {source ? ` · 来源会话「${source.title}」` : m.sessionId ? ` · ${m.sessionId}` : ''}
              </div>
            </div>
            <Button
              variant="secondary"
              className="agent-mem-item__revoke"
              onClick={() => void deleteMemory(m.name)}
              title="撤销该记忆（删除后即时生效）"
            >
              <Trash2 size={12} aria-hidden />
              撤销
            </Button>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="agent-page">
      <AgentSubNav />
      <div className="agent-mem-page">
        <header className="agent-mem-head">
          <div>
            <h2 className="agent-mem-head__title">记忆管理</h2>
            <p className="agent-mem-head__desc">
              Agent 主动沉淀的知识记忆（D15 主动轨）：会话中学到的用户偏好、项目事实、工作反馈与外部参考；撤销即时生效。
            </p>
          </div>
          <span className="agent-mem-head__count">共 {memories.length} 条</span>
        </header>
        <div className="agent-filter-tabs" role="tablist" aria-label="记忆类型筛选">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={filter === f.value}
              className={`agent-filter-tab${filter === f.value ? ' agent-filter-tab--active' : ''}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
              <span className="agent-filter-tab__count">
                {f.value === 'all' ? memories.length : memories.filter((m) => m.type === f.value).length}
              </span>
            </button>
          ))}
        </div>
        {state === 'ok' ? (
          listNode
        ) : (
          <StateView
            state={state}
            skeleton={<SkeletonList count={5} />}
            error={new Error(error ?? '记忆加载失败')}
            onRetry={() => void init()}
            emptyText={memories.length === 0 ? '还没有记忆：在会话中让 Agent「记住」偏好或事实' : `「${FILTERS.find((f) => f.value === filter)?.label}」类型暂无条目`}
            offlineText="离线中：记忆为本地数据，可正常查看与撤销"
            degradedText={degradedText ?? undefined}
          >
            {listNode}
          </StateView>
        )}
      </div>
    </div>
  );
}
