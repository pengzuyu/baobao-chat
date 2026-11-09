/**
 * 工作台右栏：上下文栏（PAG-01 §3.1 E 区，可折叠）：
 * - 会话信息：工作区/模式/模型档位/最近一轮用量/结论摘要
 * - 检查点时间线（PAG-06 简版）：cp 短号 + 时间 + reason + 文件数
 * - 记忆侧写：最近沉淀的记忆条目（D15 主动轨）
 */

import { Link } from 'react-router-dom';
import type { CheckpointItem } from '../store/agent';
import { AGENT_MODE_OPTIONS, MEMORY_TYPE_LABELS, MODEL_TIER_LABELS, SESSION_STATUS_LABELS } from '../bridge/types';
import type { AgentSessionMeta, MemoryEntry, RunInfo } from '../bridge/types';

function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const RUN_KIND_LABELS: Record<RunInfo['kind'], string> = {
  probe: '子任务',
  expert: '专家',
  team: '团队',
  delegate: '委派',
};

const RUN_STATUS_LABELS: Record<RunInfo['status'], string> = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

function formatDuration(ms: number): string {
  if (ms <= 0) return '';
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

interface AgentContextSidebarProps {
  session: AgentSessionMeta;
  model: 'fast' | 'strong' | 'auto';
  checkpoints: CheckpointItem[];
  memories: MemoryEntry[];
  usage?: { in: number; out: number };
  pendingCount: number;
  /** run 记录（D16 §3.1；新建在末尾展示最近 8 条倒序） */
  runs: RunInfo[];
}

export function AgentContextSidebar({ session, model, checkpoints, memories, usage, pendingCount, runs }: AgentContextSidebarProps) {
  const modeLabel = AGENT_MODE_OPTIONS.find((m) => m.value === session.mode)?.label ?? session.mode;

  return (
    <div className="agent-side">
      <div className="agent-side__section">
        <div className="agent-side__title">会话信息</div>
        <dl className="agent-side__kv">
          <dt>工作区</dt>
          <dd title={session.workspace}>{session.workspace}</dd>
          <dt>状态</dt>
          <dd>{SESSION_STATUS_LABELS[session.status]}</dd>
          <dt>权限模式</dt>
          <dd>{modeLabel}</dd>
          <dt>模型档位</dt>
          <dd>{MODEL_TIER_LABELS[model]}</dd>
          {usage ? (
            <>
              <dt>最近用量</dt>
              <dd>
                in {usage.in.toLocaleString()} / out {usage.out.toLocaleString()} tokens
              </dd>
            </>
          ) : null}
          {session.summary ? (
            <>
              <dt>结论摘要</dt>
              <dd>{session.summary}</dd>
            </>
          ) : null}
        </dl>
      </div>

      <div className="agent-side__section">
        <div className="agent-side__title">运行记录</div>
        {runs.length === 0 ? (
          <div className="agent-side__empty">暂无子任务（探查/专家/委派启动后在此可见）</div>
        ) : (
          <ul className="agent-run-list">
            {[...runs].reverse().slice(0, 8).map((r) => (
              <li key={r.id} className="agent-run-item" title={`${r.id} · ${r.defRef}${r.summary ? ` · ${r.summary.slice(0, 120)}` : ''}`}>
                <span className={`agent-run-item__kind agent-run-item__kind--${r.kind}`}>{RUN_KIND_LABELS[r.kind]}</span>
                <span className="agent-run-item__def">{r.defRef.replace('backend:', '').replace('builtin.', '')}</span>
                <span
                  className={`agent-run-item__status agent-run-item__status--${r.status}${r.status === 'running' ? ' agent-run-item__status--live' : ''}`}
                >
                  {RUN_STATUS_LABELS[r.status]}
                  {r.status === 'running' && r.etaHintMs > 0 ? ` ~${formatDuration(r.etaHintMs)}` : ''}
                  {r.etaActualMs > 0 ? ` ${formatDuration(r.etaActualMs)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="agent-side__section">
        <div className="agent-side__title">
          检查点时间线
          {pendingCount > 0 ? <span className="agent-side__badge">{pendingCount} 待审批</span> : null}
        </div>
        {checkpoints.length === 0 ? (
          <div className="agent-side__empty">暂无检查点（修改类工具执行前自动创建）</div>
        ) : (
          <ul className="agent-cp-list">
            {checkpoints.map((cp) => (
              <li key={cp.id} className="agent-cp-item">
                <span className="agent-cp-item__id" title={cp.id}>
                  {cp.id.replace(/^cp-/, '')}
                </span>
                <span className="agent-cp-item__time">{formatClock(cp.createdAt)}</span>
                <span className="agent-cp-item__reason">{cp.reason}</span>
                <span className="agent-cp-item__files">{cp.filesChanged.length} 文件</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="agent-side__section">
        <div className="agent-side__title">记忆侧写</div>
        {memories.length === 0 ? (
          <div className="agent-side__empty">还没有沉淀的记忆</div>
        ) : (
          <ul className="agent-memory-mini">
            {memories.slice(0, 5).map((m) => (
              <li key={m.name} className="agent-memory-mini__item" title={m.hook}>
                <span className={`agent-mem-chip agent-mem-chip--${m.type}`}>{MEMORY_TYPE_LABELS[m.type]}</span>
                <span className="agent-memory-mini__title">{m.title}</span>
              </li>
            ))}
          </ul>
        )}
        <Link to="/agent/memory" className="agent-side__more">
          查看全部记忆 →
        </Link>
      </div>
    </div>
  );
}
