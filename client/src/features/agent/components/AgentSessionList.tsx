/**
 * 工作台左栏：项目/日常对话/任务三分区（2026-11-11 在 D19 两分区上增任务区，ZCode 同款形态）：
 * - 项目区：登记表（workspace.list）∪ 会话中出现的目录兜底；项目行（名称+路径+会话数）
 *   可折叠内嵌该项目会话；行内动作=新会话/移除登记
 * - 日常对话区：workspace='' 且 IM 来源（embeddedIds 命中，💬 徽标，标题=「与xxx的对话」/
 *   「xxx · 群聊」）的会话平铺；2026-11-17 收窄——工作台建的空目录会话改落任务区
 * - 任务区：任务会话（workspace='' 非 IM 来源——含任务区「+」新建与历史数据）平铺
 *   （2026-11-19：**run 记录整块移出左栏**——子 agent 过程归右栏内容坞，按主会话
 *   归属/隔离；左栏只留会话本身）
 * - 顶部双入口：[+ 新建任务会话（任务区头）] [打开项目目录（项目区头，plugin-dialog 目录选择）]
 * - 会话项：状态点（●运行/◐等待/○暂停/✕错误/▪结束）+ 标题 + 相对时间 + 状态 chip
 * - 六态由父层推导后传入（loading/empty/error/offline 走 StateView）
 * D26-O4：列表体→antd Menu（分组标签=分区头、SubMenu=项目分组、选中态=活跃会话），
 * 状态点→Badge、chip→Tag、失败条→Alert、底部链接内联化（agent-session-item/agent-proj-*
 * /agent-task-item/agent-sublink 等自研样式退役）。
 * 行高（2026-11-17 高度重叠报修）：antd Menu 项定高 40px 且行高 40px 会向内层继承，
 * 双行 label（标题+时间）按 40px/行撑破定高项→裁切串行——各 label 统一 inline-flex +
 * verticalAlign:middle + lineHeight 1.4 自管行高，双行内容 ~36px 收进 40px 项内。
 * 会话折叠（2026-11-19 用户口径，历史会话长期占位）：项目分组/任务区默认只列最近
 * INITIAL_SESSION_LIMIT(5) 条，其余收成「加载更多（还有 N 条）」，每次点击再放
 * LOAD_MORE_STEP(10) 条；项目分组收起→展开重置回 5 条，左栏整体收起会卸载本组件、
 * 重新展开同样回到初始态（日常对话区不在本次折叠口径内）。
 */

import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Badge, Flex, Menu, Tag, Typography, theme } from 'antd';
import type { MenuProps } from 'antd';
import { Bot, ChevronDown, FolderOpen, ListTodo, MessageSquare, PanelLeftClose, Plus, Trash2 } from 'lucide-react';
import type { AgentSessionMeta, AgentWorkspaceInfo } from '../bridge/types';
import { SESSION_STATUS_LABELS } from '../bridge/types';
import { Button } from '../../../shared/ui/Button';
import { formatListTime } from '../../../shared/utils/time';
import { embeddedSessionIds } from '../../im/agent/embedded';

/** 状态点形态（D08 §3.1：●运行 / ◐等待审批 / ○暂停 / ✕错误 / ▪已结束）→ antd Badge 状态 */
function statusBadge(status: AgentSessionMeta['status']): 'success' | 'processing' | 'error' | 'warning' | 'default' {
  switch (status) {
    case 'running':
    case 'subagent_fanout':
      return 'processing';
    case 'waiting_permission':
    case 'waiting_clarify':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'default'; // paused/ended/idle/未知态
  }
}

/** 状态 chip 色（原 agent-status-chip--* 口径） */
function statusTagColor(status: AgentSessionMeta['status']): string | undefined {
  switch (status) {
    case 'running':
    case 'subagent_fanout':
      return 'success';
    case 'waiting_permission':
    case 'waiting_clarify':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return undefined; // paused/ended 默认灰
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

/** 会话折叠口径（2026-11-19）：默认只显示最近 5 条，点「加载更多」每次再放 10 条 */
const INITIAL_SESSION_LIMIT = 5;
const LOAD_MORE_STEP = 10;
/** 任务区折叠计数的 storage key（项目分组用 proj:<path>） */
const TASKS_GROUP_KEY = 'tasks';

interface AgentSessionListProps {
  sessions: AgentSessionMeta[];
  workspaces: AgentWorkspaceInfo[];
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
  const { token } = theme.useToken();
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

  // 空 workspace 会话二分（2026-11-17 用户报修：任务区「+」新建的会话发送消息后落进
  // 了日常区——2026-11-12 曾把全部 workspace='' 平铺进日常区兜底「新建不落左栏」，
  // 副作用即本Bug）。现按来源分区：embeddedIds 命中=IM 来源（💬）→「日常对话」；
  // 其余（工作台建的空目录会话，含历史未标记数据）→「任务」区。
  // embedded 映射（IndexedDB）由 IM 侧在 ensureEmbeddedSession 建会话时恒写入，
  // 未命中即工作台来源——口径对历史数据同样成立
  const { chatSessions, taskSessions } = useMemo(() => {
    const chats: AgentSessionMeta[] = [];
    const tasks: AgentSessionMeta[] = [];
    for (const s of dailySessions) (embeddedIds.has(s.id) ? chats : tasks).push(s);
    return { chatSessions: chats, taskSessions: tasks };
  }, [dailySessions, embeddedIds]);

  // 折叠态：默认展开含活跃会话的项目；切项目即用（状态不持久化，v0.1 简化）
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // 「加载更多」展开量（key=proj:<path> / tasks）：未记录=初始 5 条；
  // 项目分组收起时清回初始态（重新展开回到最近 5 条，用户口径 2026-11-19）
  const [sessionLimits, setSessionLimits] = useState<Record<string, number>>({});
  const activeIn = (g: ProjectGroup) => g.sessions.some((s) => s.id === activeId);
  const isOpen = (g: ProjectGroup) => (collapsed[g.path] === undefined ? true : !collapsed[g.path]);

  /** 分区头（Menu group 标签）：图标 + 标题 + 尾部动作（inline-flex 自管行高——
   *  24px 动作钮须脱离 group 标题 22px 行高，见文件头「行高」注） */
  const sectionHead = (icon: ReactNode, title: string, extra?: ReactNode, after?: ReactNode) => (
    <span
      style={{
        display: 'inline-flex',
        verticalAlign: 'middle',
        alignItems: 'center',
        gap: 4,
        width: '100%',
        fontSize: 11,
        lineHeight: 1.4,
        color: token.colorTextTertiary,
        userSelect: 'none',
      }}
    >
      {icon}
      {title}
      {after}
      <span style={{ flex: 1 }} />
      {extra}
    </span>
  );

  /** 头部小动作钮（打开项目/新建任务） */
  const headAct = (title: string, onClick: (() => void) | undefined) =>
    onClick ? (
      <Button variant="text" size="small" icon={<Plus size={12} aria-hidden />} title={title} onClick={onClick} />
    ) : null;

  /** 会话行 label（状态点 + 标题/时间两行 + 状态 chip）。origin=无 workspace 时的
   *  来源文案（日常区=IM 来源 / 任务区=任务会话）；inline-flex 自管行高见文件头注 */
  const sessionLabel = (s: AgentSessionMeta, origin = '日常对话（无工作目录）') => (
    <span
      style={{ display: 'inline-flex', verticalAlign: 'middle', alignItems: 'center', gap: 8, minWidth: 0, width: '100%', lineHeight: 1.4 }}
      title={`${s.title} · ${SESSION_STATUS_LABELS[s.status]} · ${s.workspace || origin}`}
    >
      <Badge status={statusBadge(s.status)} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {embeddedIds.has(s.id) ? (
            <span title="来自聊天会话（IM @Agent）" style={{ color: token.colorPrimary, display: 'inline-flex', marginRight: 3, verticalAlign: -1 }}>
              <Bot size={11} aria-hidden />
            </span>
          ) : null}
          {s.title}
        </span>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatListTime(s.updatedAt)}
        </Typography.Text>
      </span>
      <Tag color={statusTagColor(s.status)} style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px', paddingInline: 4, flexShrink: 0 }}>
        {SESSION_STATUS_LABELS[s.status]}
      </Tag>
    </span>
  );

  /** 分区空态提示行（disabled 项承载次要文字） */
  const hintItem = (key: string, text: string): NonNullable<MenuProps['items']>[number] => ({
    key,
    disabled: true,
    label: (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {text}
      </Typography.Text>
    ),
  });

  const projKey = (path: string) => `proj:${path}`;
  const sessionKey = (id: string) => `session:${id}`;
  const limitOf = (groupKey: string) => sessionLimits[groupKey] ?? INITIAL_SESSION_LIMIT;

  /** 「加载更多」行（折叠后剩余条数提示；点击在 onMenuClick 按 more:<组key> 展开） */
  const moreItem = (groupKey: string, remaining: number): NonNullable<MenuProps['items']>[number] => ({
    key: `more:${groupKey}`,
    label: (
      <span style={{ display: 'inline-flex', verticalAlign: 'middle', alignItems: 'center', gap: 4, lineHeight: 1.4, fontSize: 12, color: token.colorPrimary }}>
        <ChevronDown size={12} aria-hidden />
        加载更多
        <span style={{ fontSize: 11, color: token.colorTextTertiary }}>（还有 {remaining} 条）</span>
      </span>
    ),
  });

  /** 会话子项折叠：只列前 N 条（初始 5 / 点过「加载更多」逐次 +10），其余收进「加载更多」 */
  const foldedSessionItems = (groupKey: string, list: AgentSessionMeta[], origin?: string): NonNullable<MenuProps['items']> => {
    const shown = list.slice(0, limitOf(groupKey));
    const children: NonNullable<MenuProps['items']> = shown.map((s) => ({ key: sessionKey(s.id), title: s.title, label: sessionLabel(s, origin) }));
    const remaining = list.length - shown.length;
    if (remaining > 0) children.push(moreItem(groupKey, remaining));
    return children;
  };

  const items: MenuProps['items'] = [
    {
      key: 'grp:projects',
      type: 'group',
      label: sectionHead(<FolderOpen size={12} aria-hidden />, '项目', headAct('打开项目目录（选择工作目录做代码开发）', onOpenProject)),
      children:
        projectGroups.length === 0
          ? [hintItem('hint:no-proj', '还没有项目——点「打开项目」选一个代码目录')]
          : projectGroups.map((g) => ({
              key: projKey(g.path),
              title: g.path,
              label: (
                <span style={{ display: 'inline-flex', verticalAlign: 'middle', alignItems: 'center', gap: 6, minWidth: 0, width: '100%', lineHeight: 1.4 }} title={g.path}>
                  <span
                    style={{
                      fontWeight: 600,
                      flexShrink: 0,
                      maxWidth: '40%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: activeIn(g) ? token.colorPrimary : undefined,
                    }}
                  >
                    {g.name}
                  </span>
                  <Typography.Text type="secondary" ellipsis style={{ fontSize: 11, flex: 1, minWidth: 0 }}>
                    {shortPath(g.path)}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                    {g.sessions.length}
                  </Typography.Text>
                  {/* 行内动作：新会话/移除登记（原 hover 显隐，改常显小图标钮） */}
                  <span style={{ display: 'inline-flex', gap: 2, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="text"
                      size="small"
                      icon={<Plus size={12} aria-hidden />}
                      title="在本项目新建会话"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewProjectSession(g.path);
                      }}
                    />
                    {g.id ? (
                      <Button
                        variant="text"
                        size="small"
                        danger
                        icon={<Trash2 size={12} aria-hidden />}
                        title="移除项目登记（不影响会话与记忆）"
                        onClick={(e) => {
                          e.stopPropagation();
                          onForgetProject(g.id as string);
                        }}
                      />
                    ) : null}
                  </span>
                </span>
              ),
              children:
                g.sessions.length === 0
                  ? [hintItem(`hint:${g.path}`, '暂无会话——点项目行上的 + 新建')]
                  : foldedSessionItems(projKey(g.path), g.sessions),
            })),
    },
    {
      key: 'grp:daily',
      type: 'group',
      label: sectionHead(<MessageSquare size={12} aria-hidden />, '日常对话'),
      children:
        chatSessions.length === 0
          ? [hintItem('hint:no-daily', '在私聊/群聊里 @Agent 或点聊天头 🤖 即产生对应会话')]
          : chatSessions.map((s) => ({ key: sessionKey(s.id), title: s.title, label: sessionLabel(s, 'IM 来源 · 无工作目录') })),
    },
    {
      key: 'grp:tasks',
      type: 'group',
      label: sectionHead(<ListTodo size={12} aria-hidden />, '任务', headAct('新建任务会话', onNewTask)),
      // 任务会话（+ 新建即落此区）；子 agent run 记录不在左栏（右栏内容坞按会话归属展示）
      // 2026-11-19：超过 5 条折叠，点「加载更多」逐次展开
      children:
        taskSessions.length === 0
          ? [hintItem('hint:no-task', '点右上 + 新建任务会话；子任务过程点子任务卡「查看过程」在右栏查看')]
          : foldedSessionItems(TASKS_GROUP_KEY, taskSessions, '任务会话 · 无工作目录'),
    },
  ];

  const openKeys = projectGroups.filter(isOpen).map((g) => projKey(g.path));
  const onOpenChange = (keys: string[]) => {
    // 项目分组展开态收敛回 collapsed 记录（默认展开=未记录）
    const open = new Set(keys);
    // 收起的分组重置「加载更多」——重新展开回到最近 5 条（用户口径 2026-11-19）
    const wasOpen = new Set(openKeys);
    setSessionLimits((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const g of projectGroups) {
        const k = projKey(g.path);
        if (wasOpen.has(k) && !open.has(k) && next[k] !== undefined) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setCollapsed(Object.fromEntries(projectGroups.map((g) => [g.path, !open.has(projKey(g.path))])));
  };

  const onMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key.startsWith('session:')) {
      onSelect(key.slice('session:'.length));
      return;
    }
    if (key.startsWith('more:')) {
      // 加载更多：该分组（proj:<path> / tasks）展开量 +10
      const groupKey = key.slice('more:'.length);
      setSessionLimits((prev) => ({ ...prev, [groupKey]: (prev[groupKey] ?? INITIAL_SESSION_LIMIT) + LOAD_MORE_STEP }));
      return;
    }
    // 分组标签/提示行不响应
  };


  return (
    <>
      <Flex align="center" justify="space-between" style={{ padding: '8px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          会话
        </Typography.Text>
        {onCollapse ? (
          <Button variant="text" size="small" icon={<PanelLeftClose size={15} aria-hidden />} onClick={onCollapse} title="折叠会话列表" />
        ) : null}
      </Flex>
      {createError ? <Alert type="error" showIcon message={createError} style={{ margin: '8px 12px 0' }} /> : null}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '4px 0' }}>
        <Menu
          mode="inline"
          style={{ borderInlineEnd: 'none' }}
          items={items}
          selectedKeys={activeId ? [sessionKey(activeId)] : []}
          openKeys={openKeys}
          onOpenChange={onOpenChange}
          onClick={onMenuClick}
        />
      </div>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '4px 8px',
          padding: '8px 12px',
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Tag
          style={{ marginInlineEnd: 0, fontSize: 10 }}
          title={bridgeKind === 'mock' ? '未检测到 Tauri 宿主，正在使用本地演示剧本' : '已连接宿主 Runtime'}
        >
          {bridgeKind === 'mock' ? '演示桥' : '宿主桥'}
        </Tag>
        <Button variant="text" size="small" onClick={() => navigate('/settings/agent')}>
          Agent 设置
        </Button>
      </div>
    </>
  );
});
