/**
 * 工作台左栏：项目/日常两分区会话列表（D19，ZCode 同款形态）：
 * - 项目区：登记表（workspace.list）∪ 会话中出现的目录兜底；项目行（名称+路径+会话数）
 *   可折叠内嵌该项目会话；hover 动作=新会话/移除登记
 * - 日常对话区：workspace='' 的会话平铺（无工作目录——文件/命令类工具不可用）
 * - 顶部双入口：[+ 日常对话] [打开项目目录]（plugin-dialog 目录选择）
 * - 会话项：状态点（●运行/◐等待/○暂停/✕错误/▪结束）+ 标题 + 相对时间 + 状态 chip
 * - 六态由父层推导后传入（loading/empty/error/offline 走 StateView）
 */

import { useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Book, Calendar, ChevronDown, FolderOpen, MessageSquare, Plus, Trash2 } from 'lucide-react';
import type { AgentSessionMeta, AgentWorkspaceInfo } from '../bridge/types';
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

/** 路径短显（家目录前缀折叠 + 只留尾两段） */
function shortPath(path: string): string {
  const p = path.replace(/^\/Users\/[^/]+/, '~');
  const segs = p.split('/').filter(Boolean);
  return segs.length <= 2 ? p : `…/${segs.slice(-2).join('/')}`;
}

/** 项目展示行（登记表行 ∪ 会话路径兜底行的统一形状） */
interface ProjectGroup {
  /** 登记表 id（有则可移除；兜底行 undefined） */
  id?: string;
  name: string;
  path: string;
  sessions: AgentSessionMeta[];
}

interface AgentSessionListProps {
  sessions: AgentSessionMeta[];
  workspaces: AgentWorkspaceInfo[];
  activeId: string | null;
  bridgeKind: 'mock' | 'tauri';
  /** 新建会话失败提示（bbrt 缺失/超时/超限；成功后清除） */
  createError?: string | null;
  onSelect: (id: string) => void;
  /** 新建日常对话（无工作目录） */
  onNewDaily: () => void;
  /** 打开项目目录（页面层弹系统目录选择框，选完登记+建会话） */
  onOpenProject: () => void;
  /** 在既有项目里新建会话 */
  onNewProjectSession: (path: string) => void;
  /** 移除项目登记（只删登记，不动会话/记忆） */
  onForgetProject: (id: string) => void;
}

export function AgentSessionList({
  sessions,
  workspaces,
  activeId,
  bridgeKind,
  createError,
  onSelect,
  onNewDaily,
  onOpenProject,
  onNewProjectSession,
  onForgetProject,
}: AgentSessionListProps) {
  const navigate = useNavigate();

  // 项目分组：登记表 ∪ 会话出现的路径（登记表顺序优先=最近打开在前）
  const { projectGroups, dailySessions } = useMemo(() => {
    const daily: AgentSessionMeta[] = [];
    const byPath = new Map<string, ProjectGroup>();
    for (const w of workspaces) {
      byPath.set(w.path, { id: w.id, name: w.name, path: w.path, sessions: [] });
    }
    for (const s of sessions) {
      if (!s.workspace) {
        daily.push(s);
        continue;
      }
      const group = byPath.get(s.workspace) ?? { name: s.workspace.split('/').filter(Boolean).pop() ?? '项目', path: s.workspace, sessions: [] };
      group.sessions.push(s);
      byPath.set(s.workspace, group);
    }
    const groups = [...byPath.values()].sort((a, b) => {
      const at = a.sessions[0]?.updatedAt ?? 0;
      const bt = b.sessions[0]?.updatedAt ?? 0;
      return bt - at;
    });
    return { projectGroups: groups, dailySessions: daily };
  }, [sessions, workspaces]);

  // 折叠态：默认展开含活跃会话的项目；切项目即用（状态不持久化，v0.1 简化）
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const activeIn = (g: ProjectGroup) => g.sessions.some((s) => s.id === activeId);
  const isOpen = (g: ProjectGroup) => (collapsed[g.path] === undefined ? true : !collapsed[g.path]);

  const sessionRow = (s: AgentSessionMeta, indent = false) => (
    <button
      key={s.id}
      type="button"
      className={`agent-session-item${s.id === activeId ? ' agent-session-item--active' : ''}`}
      style={indent ? { paddingLeft: 14 } : undefined}
      onClick={() => onSelect(s.id)}
      title={`${s.title} · ${SESSION_STATUS_LABELS[s.status]} · ${s.workspace || '日常对话（无工作目录）'}`}
    >
      <span className={`agent-dot ${statusDotClass(s.status)}`} aria-hidden />
      <span className="agent-session-item__main">
        <span className="agent-session-item__name">{s.title}</span>
        <span className="agent-session-item__meta">
          <span className="agent-session-item__time">{formatListTime(s.updatedAt)}</span>
        </span>
      </span>
      <span className={`agent-status-chip agent-status-chip--${s.status}`}>{SESSION_STATUS_LABELS[s.status]}</span>
    </button>
  );

  return (
    <>
      <div className="agent-sessions__header">
        <span className="agent-sessions__title">会话</span>
      </div>
      <div className="agent-sessions__newbar">
        <button type="button" className="agent-new-btn" onClick={onNewDaily} title="新建日常对话（不绑定工作目录）">
          <Plus size={13} aria-hidden />
          日常对话
        </button>
        <button
          type="button"
          className="agent-new-btn"
          onClick={onOpenProject}
          title="打开项目目录（绑定工作目录做代码开发）"
        >
          <FolderOpen size={13} aria-hidden />
          打开项目
        </button>
      </div>
      {createError ? (
        <div className="agent-create-error" role="alert">
          {createError}
        </div>
      ) : null}
      <div className="agent-sessions__body">
        {/* 项目区 */}
        <section className="agent-proj-section" aria-label="项目">
          <div className="agent-proj-section__head">
            <FolderOpen size={12} aria-hidden />
            项目
          </div>
          {projectGroups.length === 0 ? (
            <div className="agent-proj-group__path" style={{ padding: '2px 12px 6px' }}>
              还没有项目——点「打开项目」选一个代码目录
            </div>
          ) : (
            projectGroups.map((g) => (
              <div key={g.path} className="agent-proj-group">
                <button
                  type="button"
                  className={`agent-proj-group__head${activeIn(g) ? ' agent-proj-group__head--active' : ''}`}
                  onClick={() => setCollapsed((c) => ({ ...c, [g.path]: !isOpen(g) }))}
                  title={g.path}
                >
                  <ChevronDown size={12} className={`tool-group__chev${isOpen(g) ? ' tool-group__chev--open' : ''}`} aria-hidden />
                  <span className="agent-proj-group__name">{g.name}</span>
                  <span className="agent-proj-group__path">{shortPath(g.path)}</span>
                  <span className="agent-proj-group__count">{g.sessions.length}</span>
                  <span className="agent-proj-group__acts">
                    <span
                      role="button"
                      tabIndex={0}
                      className="agent-proj-group__act"
                      title="在本项目新建会话"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewProjectSession(g.path);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.stopPropagation();
                          onNewProjectSession(g.path);
                        }
                      }}
                    >
                      <Plus size={12} aria-hidden />
                    </span>
                    {g.id ? (
                      <span
                        role="button"
                        tabIndex={0}
                        className="agent-proj-group__act agent-proj-group__act--danger"
                        title="移除项目登记（不影响会话与记忆）"
                        onClick={(e) => {
                          e.stopPropagation();
                          onForgetProject(g.id as string);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.stopPropagation();
                            onForgetProject(g.id as string);
                          }
                        }}
                      >
                        <Trash2 size={12} aria-hidden />
                      </span>
                    ) : null}
                  </span>
                </button>
                {isOpen(g) ? (
                  <div className="agent-proj-group__sessions">
                    {g.sessions.length === 0 ? (
                      <div className="agent-proj-group__path" style={{ padding: '2px 8px 6px' }}>
                        暂无会话——hover 项目行点 + 新建
                      </div>
                    ) : (
                      g.sessions.map((s) => sessionRow(s, true))
                    )}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </section>

        {/* 日常对话区 */}
        <section className="agent-proj-section" aria-label="日常对话">
          <div className="agent-proj-section__head">
            <MessageSquare size={12} aria-hidden />
            日常对话
          </div>
          {dailySessions.length === 0 ? (
            <div className="agent-proj-group__path" style={{ padding: '2px 12px 6px' }}>
              无工作目录的轻量问答会话
            </div>
          ) : (
            dailySessions.map((s) => sessionRow(s))
          )}
        </section>
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
