/**
 * 工作台左栏：会话列表（PAG-01 §3.1 A 区，窄栏）：
 * - 每项：状态点 + 标题 + 相对时间；状态点色 ●运行绿/◐等待审批橙/○暂停灰/✕错误红/▪已结束灰
 * - 顶部 [新建会话]；底部二级导航（记忆管理 / 日报）+ 桥接模式徽标
 * - 六态由父层推导后传入（loading/empty/error/offline 走 StateView）
 */

import { NavLink, useNavigate } from 'react-router-dom';
import { Book, Calendar, Plus } from 'lucide-react';
import type { AgentSessionMeta } from '../bridge/types';
import { SESSION_STATUS_LABELS } from '../bridge/types';
import { formatListTime } from '../../../shared/utils/time';

/** 状态点形态（D08 §3.1：●运行 / ◐等待审批 / ○暂停 / ✕错误 / ▪已结束） */
function statusDotClass(status: AgentSessionMeta['status']): string {
  switch (status) {
    case 'running':
    case 'subagent_fanout':
    case 'delegating':
      return 'agent-dot--running';
    case 'waiting_permission':
    case 'waiting_review':
      return 'agent-dot--waiting';
    case 'paused':
      return 'agent-dot--paused';
    case 'error':
      return 'agent-dot--error';
    case 'ended':
      return 'agent-dot--ended';
    default:
      return 'agent-dot--idle'; // starting/idle
  }
}

interface AgentSessionListProps {
  sessions: AgentSessionMeta[];
  activeId: string | null;
  bridgeKind: 'mock' | 'tauri';
  /** 新建会话失败提示（bbrt 缺失/超时/超限；成功后清除） */
  createError?: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

export function AgentSessionList({ sessions, activeId, bridgeKind, createError, onSelect, onCreate }: AgentSessionListProps) {
  const navigate = useNavigate();
  return (
    <>
      <div className="agent-sessions__header">
        <span className="agent-sessions__title">会话</span>
        <button type="button" className="agent-new-btn" onClick={onCreate} title="新建会话（默认工作区 ~/code/bbw-server）">
          <Plus size={13} aria-hidden />
          新会话
        </button>
      </div>
      {createError ? (
        <div className="agent-create-error" role="alert">
          {createError}
        </div>
      ) : null}
      <div className="agent-sessions__body">
        {sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`agent-session-item${s.id === activeId ? ' agent-session-item--active' : ''}`}
            onClick={() => onSelect(s.id)}
            title={`${s.title} · ${SESSION_STATUS_LABELS[s.status]} · ${s.workspace}`}
          >
            <span className={`agent-dot ${statusDotClass(s.status)}`} aria-hidden />
            <span className="agent-session-item__main">
              <span className="agent-session-item__name">{s.title}</span>
              <span className="agent-session-item__meta">
                <span className="agent-session-item__ws">{s.workspace.replace(/^~/, '')}</span>
                <span className="agent-session-item__time">{formatListTime(s.updatedAt)}</span>
              </span>
            </span>
            <span className={`agent-status-chip agent-status-chip--${s.status}`}>{SESSION_STATUS_LABELS[s.status]}</span>
          </button>
        ))}
      </div>
      <div className="agent-sessions__footer">
        <NavLink to="/agent/memory" className={({ isActive }) => `agent-sublink${isActive ? ' agent-sublink--active' : ''}`}>
          <Book size={13} aria-hidden />
          记忆管理
        </NavLink>
        <NavLink to="/agent/reports" className={({ isActive }) => `agent-sublink${isActive ? ' agent-sublink--active' : ''}`}>
          <Calendar size={13} aria-hidden />
          Agent 日报
        </NavLink>
        <span className="agent-bridge-badge" title={bridgeKind === 'mock' ? '未检测到 Tauri 宿主，正在使用本地演示剧本' : '已连接宿主 Runtime'}>
          {bridgeKind === 'mock' ? '演示桥' : '宿主桥'}
        </span>
        <button type="button" className="agent-sublink agent-sublink--plain" onClick={() => navigate('/settings/agent')}>
          Agent 设置
        </button>
      </div>
    </>
  );
}
