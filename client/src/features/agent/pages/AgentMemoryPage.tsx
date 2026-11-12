/**
 * PAG-11 三级记忆管理页（/agent/memory，D08 §3.11 / D15 §2.1；D19 增作用域）：
 * - 作用域页签：用户记忆（全局）/ 项目记忆（按项目分区选择）
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
  const forgetMemory = useAgentStore((s) => s.forgetMemory);
  const sessions = useAgentStore((s) => s.sessions);
  // D19 作用域视图（用户记忆 / 项目记忆+项目选择）
  const memoryScope = useAgentStore((s) => s.memoryScope);
  const memoryWorkspacePath = useAgentStore((s) => s.memoryWorkspacePath);
  const loadMemories = useAgentStore((s) => s.loadMemories);
  const workspaces = useAgentStore((s) => s.workspaces);

  const [filter, setFilter] = useState<Filter>('all');

  /** 项目页签缺省选第一个项目（记忆页直达时兜底） */
  useEffect(() => {
    if (memoryScope === 'project' && !memoryWorkspacePath && workspaces.length > 0) {
      void loadMemories('project', workspaces[0].path);
    }
  }, [memoryScope, memoryWorkspacePath, workspaces, loadMemories]);

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
        // D23：globalType 携带=公共层 USER.md 条目——chip 用十类标签、撤销走 forget
        const isGlobal = Boolean(m.globalType);
        return (
          <div key={`${m.scope ?? 'user'}-${m.workspaceName ?? ''}-${m.name}`} className="agent-mem-item" data-memory-name={m.name}>
            <div className="agent-mem-item__main">
              <div className="agent-mem-item__title-row">
                <span className={`agent-mem-chip agent-mem-chip--${m.type}`}>{m.globalType ?? MEMORY_TYPE_LABELS[m.type]}</span>
                {(m.scope ?? 'user') === 'project' ? (
                  <span className="agent-mem-chip agent-mem-chip--projectscope" title={m.workspaceName}>
                    {workspaces.find((w) => (m.workspaceName ?? '').startsWith(`${w.name}-`))?.name ?? m.workspaceName ?? '项目'}
                  </span>
                ) : null}
                <span className="agent-mem-item__title">{m.title}</span>
              </div>
              {m.hook && m.hook !== m.title ? <div className="agent-mem-item__hook">{m.hook}</div> : null}
              <div className="agent-mem-item__meta">
                {m.updatedAt ? `更新 ${formatDay(m.updatedAt)}` : '公共层（USER.md 压实视图）'}
                {source ? ` · 来源会话「${source.title}」` : m.sessionId ? ` · ${m.sessionId}` : ''}
              </div>
            </div>
            <Button
              variant="secondary"
              className="agent-mem-item__revoke"
              onClick={() =>
                isGlobal
                  ? void forgetMemory(m.globalType ?? '', m.title)
                  : void deleteMemory(m.name, memoryScope, memoryWorkspacePath ?? undefined)
              }
              title={isGlobal ? '移除该公共记忆（条目粒度，即时生效）' : '撤销该记忆（删除后即时生效）'}
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
        {/* D19 作用域页签：用户记忆 / 项目记忆（+ 项目选择） */}
        <div className="agent-filter-tabs" role="tablist" aria-label="记忆作用域">
          <button
            type="button"
            role="tab"
            aria-selected={memoryScope === 'user'}
            className={`agent-filter-tab${memoryScope === 'user' ? ' agent-filter-tab--active' : ''}`}
            onClick={() => void loadMemories('user', null)}
          >
            用户记忆
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={memoryScope === 'project'}
            className={`agent-filter-tab${memoryScope === 'project' ? ' agent-filter-tab--active' : ''}`}
            onClick={() => void loadMemories('project', memoryWorkspacePath ?? workspaces[0]?.path ?? null)}
          >
            项目记忆
          </button>
          {memoryScope === 'project' ? (
            <select
              className="agent-mem-proj-select bbw-input"
              value={memoryWorkspacePath ?? ''}
              onChange={(e) => void loadMemories('project', e.target.value || null)}
              aria-label="选择项目"
            >
              {workspaces.length === 0 ? <option value="">（还没有登记的项目）</option> : null}
              {workspaces.map((w) => (
                <option key={w.id} value={w.path}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
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
            emptyText={
              memories.length === 0
                ? memoryScope === 'project'
                  ? '该项目还没有项目记忆：在项目会话中让 Agent 记住约定与教训'
                  : '还没有用户记忆：在日常/任意会话中让 Agent「记住」偏好或事实'
                : `「${FILTERS.find((f) => f.value === filter)?.label}」类型暂无条目`
            }
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
