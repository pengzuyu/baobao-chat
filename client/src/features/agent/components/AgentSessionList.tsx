/**
 * 工作台左栏：项目/日常对话/任务三分区（2026-11-11 在 D19 两分区上增任务区，ZCode 同款形态）：
 * - 项目区：登记表（workspace.list）∪ 会话中出现的目录兜底；项目行（名称+路径+会话数）
 *   可折叠内嵌该项目会话；hover 动作=新会话/移除登记
 * - 日常对话区：workspace='' 的会话平铺（无工作目录——文件/命令类工具不可用）；
 *   IM @agent 来源的 embedded 会话带 💬 徽标（标题=「与xxx的对话」/「xxx · 群聊」）
 * - 任务区：runs.list 跨会话全量（子代理探查/专家会诊/委派），运行中置顶，点击跳所属会话
 * - 顶部双入口：[+ 日常对话] [打开项目目录]（plugin-dialog 目录选择）
 * - 会话项：状态点（●运行/◐等待/○暂停/✕错误/▪结束）+ 标题 + 相对时间 + 状态 chip
 * - 六态由父层推导后传入（loading/empty/error/offline 走 StateView）
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Book, Bot, Calendar, ChevronDown, FolderOpen, ListTodo, MessageSquare, PanelLeftClose, Plus, Trash2 } from 'lucide-react';
import type { AgentSessionMeta, AgentWorkspaceInfo, RunInfo } from '../bridge/types';
import { SESSION_STATUS_LABELS } from '../bridge/types';
import { formatListTime } from '../../../shared/utils/time';
import { embeddedSessionIds } from '../../im/agent/embedded';

/** run 类型徽标（D16 四类：探查/专家会诊/并行会诊/委派） */
const RUN_KIND_LABELS: Record<RunInfo['kind'], string> = {
  probe: '探查',
  expert: '专家',
  team: '会诊',
  delegate: '委派',
};

const RUN_STATUS_LABELS: Record<RunInfo['status'], string> = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

/** 状态点形态（D08 §3.1：●运行 / ◐等待审批 / ○暂停 / ✕错误 / ▪已结束） */
function statusDotClass(status: AgentSessionMeta['status']): string {
  switch (status) {
    case 'running':
    case 'subagent_fanout':
    case 'delegating':
      return 'agent-dot--running';
    case 'waiting_permission':
    case 'waiting_clarify':
    case 'waiting_review':
      return 'agent-dot--waiting';
    case 'paused':
      return 'agent-dot--paused';
    case 'error':
      return 'agent-dot--error';
    case 'ended':
      return 'agent-dot--ended';
    default:
      return 'agent-dot--idle'; // idle/未知态
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
  /** 跨会话全量 run（任务分区数据源；父层 loadTaskRuns 维护） */
  runs: RunInfo[];
  activeId: string | null;
  bridgeKind: 'mock' | 'tauri';
  /** 新建会话失败提示（bbrt 缺失/超时/超限；成功后清除） */
  createError?: string | null;
  onSelect: (id: string) => void;
  /** 新建任务会话（2026-11-11：任务区 + 按钮——不绑定目录的独立任务对话） */
  onNewTask: () => void;
  /** 打开项目目录（项目区 + 按钮；页面层弹系统目录选择框，选完登记+建会话） */
  onOpenProject?: () => void;
  /** 在既有项目里新建会话 */
  onNewProjectSession: (path: string) => void;
  /** 移除项目登记（只删登记，不动会话/记忆） */
  onForgetProject: (id: string) => void;
  /** 折叠整个左栏（2026-11-11：会话多时让宽给中栏；展开按钮在折叠细条上） */
  onCollapse?: () => void;
}

/** memo（2026-11-11 卡顿修复）：流式期间工作台页每 delta 重渲——本组件 props
 * （列表数据 + useCallback 回调）引用稳定时可整体跳过，左栏几百会话行不再陪跑 */
export const AgentSessionList = memo(function AgentSessionList({
  sessions,
  workspaces,
  runs,
  activeId,
  bridgeKind,
  createError,
  onSelect,
  onNewTask,
  onOpenProject,
  onNewProjectSession,
  onForgetProject,
  onCollapse,
}: AgentSessionListProps) {
  const navigate = useNavigate();

  // embedded 会话集合（💬 来源徽标；挂载时读一次——映射只在 IM 侧写入）
  const [embeddedIds, setEmbeddedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    void embeddedSessionIds().then((ids) => {
      if (!cancelled) setEmbeddedIds(ids);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 任务分区：运行中置顶，其余按创建时间倒序（最多 30 条防长列表拖垮滚动）
  const taskRuns = useMemo(() => {
    const sorted = [...runs].sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    return [...sorted.filter((r) => r.status === 'running'), ...sorted.filter((r) => r.status !== 'running')].slice(0, 30);
  }, [runs]);
  const runningCount = useMemo(() => runs.filter((r) => r.status === 'running').length, [runs]);

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

  // 日常区=全部日常会话（2026-11-12 用户报修：新建任务（工作台日常会话）发送后
  // 不落左栏——旧口径只显示 IM embedded 来源，工作台新建的日常会话无处渲染；
  // 现平铺全部 workspace='' 会话，embedded 徽标仍按来源标注）
  const chatSessions = dailySessions;

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
        <span className="agent-session-item__name">
          {embeddedIds.has(s.id) ? (
            <span className="agent-embedded-badge" title="来自聊天会话（IM @Agent）">
              <Bot size={11} aria-hidden />
            </span>
          ) : null}
          {s.title}
        </span>
        <span className="agent-session-item__meta">
          <span className="agent-session-item__time">{formatListTime(s.updatedAt)}</span>
        </span>
      </span>
      <span className={`agent-status-chip agent-status-chip--${s.status}`}>{SESSION_STATUS_LABELS[s.status]}</span>
    </button>
  );

  const sessionTitleOf = (sid: string): string => sessions.find((s) => s.id === sid)?.title ?? '';

  const taskRow = (r: RunInfo) => (
    <button
      key={r.id}
      type="button"
      className="agent-task-item"
      onClick={() => navigate(`/agent/s/${r.sessionId}`)}
      title={`${RUN_KIND_LABELS[r.kind]} · ${sessionTitleOf(r.sessionId) || r.sessionId} · ${RUN_STATUS_LABELS[r.status]}`}
    >
      <span className={`agent-task-item__kind agent-task-item__kind--${r.kind}`}>{RUN_KIND_LABELS[r.kind]}</span>
      <span className="agent-task-item__main">
        <span className="agent-task-item__name">{r.summary || r.defRef || r.id}</span>
        <span className="agent-task-item__meta">
          <span className="agent-task-item__session">{sessionTitleOf(r.sessionId) || '未知会话'}</span>
          <span className="agent-task-item__time">{formatListTime(r.createdAt)}</span>
        </span>
      </span>
      <span className={`agent-task-item__status agent-task-item__status--${r.status}`}>{RUN_STATUS_LABELS[r.status]}</span>
    </button>
  );

  return (
    <>
      <div className="agent-sessions__header">
        <span className="agent-sessions__title">会话</span>
        {onCollapse ? (
          <button type="button" className="icon-btn agent-sessions__collapse" onClick={onCollapse} title="折叠会话列表">
            <PanelLeftClose size={15} aria-hidden />
          </button>
        ) : null}
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
            <span className="agent-proj-section__spacer" />
            {onOpenProject ? (
              <button
                type="button"
                className="agent-proj-section__act"
                onClick={onOpenProject}
                title="打开项目目录（选择工作目录做代码开发）"
              >
                <Plus size={12} aria-hidden />
              </button>
            ) : null}
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

        {/* 日常对话区（2026-11-11 用户裁决：只显示 IM 私聊/群聊来源的 embedded 会话——
            一个聊天对象/一个群聊一一对应一个会话；工作台手动建的散会话不在此陈列） */}
        <section className="agent-proj-section" aria-label="日常对话">
          <div className="agent-proj-section__head">
            <MessageSquare size={12} aria-hidden />
            日常对话
          </div>
          {chatSessions.length === 0 ? (
            <div className="agent-proj-group__path" style={{ padding: '2px 12px 6px' }}>
              在私聊/群聊里 @Agent 或点聊天头 🤖 即产生对应会话
            </div>
          ) : (
            chatSessions.map((s) => sessionRow(s))
          )}
        </section>

        {/* 任务区（2026-11-11：跨会话 run 清单，与 zcode 任务面板同形态） */}
        <section className="agent-proj-section" aria-label="任务">
          <div className="agent-proj-section__head">
            <ListTodo size={12} aria-hidden />
            任务
            {runningCount > 0 ? <span className="agent-task-running-count">{runningCount}</span> : null}
            <span className="agent-proj-section__spacer" />
            {onNewTask ? (
              <button type="button" className="agent-proj-section__act" onClick={onNewTask} title="新建任务会话">
                <Plus size={12} aria-hidden />
              </button>
            ) : null}
          </div>
          {taskRuns.length === 0 ? (
            <div className="agent-proj-group__path" style={{ padding: '2px 12px 6px' }}>
              子代理探查/专家会诊/委派任务在此汇总
            </div>
          ) : (
            taskRuns.map((r) => taskRow(r))
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
});
