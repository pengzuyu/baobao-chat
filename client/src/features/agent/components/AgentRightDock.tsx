/**
 * 工作台右栏内容坞（D33 §3.6 2026-11-19 修订：右栏通用化为「内容坞」）：
 * - **无固定 tab**：内容全部按需打开（子 agent 过程=点中栏子任务卡「查看过程」
 *   或中栏头部「历史子任务」下拉）；tab 可逐个关闭，全关后整坞不渲染
 * - **按主会话归属/隔离**：每个 tab 登记 sessionId（调用它的主会话），只渲染当前
 *   会话的 tab——切会话整条 tab 条切换，A 会话的子 agent 不会出现在 B 会话下
 * - 多子 agent 并行 = 多个 tab；tab 内容复用 AgentStreamView（与中栏同款渲染）：
 *   直播 sideStreams[runId] / run.history 回放
 * - 右上角（tab 条尾部）收起按钮 → dockCollapsed；展开入口在中栏 header 最右
 * - 宽度由页面拖拽分界条控制（useSplitWidth side='right'），本组件不管宽
 * - 扩展点：DockTab.type 未来增 browser/文件等内容类型，本坞即通用内容区
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Button, Tabs, Tag, Typography, theme } from 'antd';
import { PanelRightClose } from 'lucide-react';
import { useAgentStore, type StreamItem } from '../store/agent';
import type { AgentSessionMeta, RunInfo } from '../bridge/types';
import { RUN_KIND_LABELS, RUN_STATUS_LABELS } from '../bridge/types';
import { AgentStreamView } from './stream/AgentStreamView';

/** run 类型徽标色（专家=紫/终端=绿，探查默认） */
function runKindColor(kind: RunInfo['kind']): string | undefined {
  if (kind === 'expert') return 'purple';
  if (kind === 'terminal') return 'green';
  return undefined;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '';
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** 空流常量（selector 稳定返回：无条目时不随渲染新建引用） */
const EMPTY_ITEMS: StreamItem[] = [];

interface AgentRightDockProps {
  /** 当前会话（tab tooltip 带所属会话标题；tab 过滤按 session.id） */
  session: AgentSessionMeta;
  /** 当前会话 run 记录（tab 类型/状态/耗时反查） */
  runs: RunInfo[];
}

/** tab 内容：单个子 agent 过程（kind/状态/摘要头 + 同款流渲染，内容区自滚动） */
function RunProcessPanel({ runId, run }: { runId: string; run?: RunInfo }) {
  const { token } = theme.useToken();
  const items = useAgentStore((s) => s.sideStreams[runId]) ?? EMPTY_ITEMS;
  const running = run?.status === 'running';
  const taskText = items[0]?.kind === 'user' ? items[0].text : (run?.summary ?? '');

  // ---- 滚动跟随（2026-11-24 对齐中栏口径：贴底跟随新输出，用户上滚即停跟）----
  // RO 观察内容层增高吸底（内容层恒挂载，观察器一次注册即稳）+ 运行中 300ms 兜底
  // 轮询（对齐聊天页 agentRunning 口径，cleanup 补滚一次兜收口）；切 tab 重置贴底首跳
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const onDockScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);
  useEffect(() => {
    stickRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runId]);
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (!stickRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (stickRef.current) el.scrollTop = el.scrollHeight;
      });
    });
    ro.observe(content);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
  useEffect(() => {
    if (!running) return;
    const follow = () => {
      const el = scrollRef.current;
      if (el && stickRef.current) el.scrollTop = el.scrollHeight;
    };
    const timer = window.setInterval(follow, 300);
    return () => {
      window.clearInterval(timer);
      follow();
    };
  }, [running]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 8 }}>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {run ? (
          <Tag color={runKindColor(run.kind)} style={{ marginInlineEnd: 0, flexShrink: 0 }}>
            {RUN_KIND_LABELS[run.kind]}
          </Tag>
        ) : null}
        <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, flex: 1, minWidth: 0 }} title={taskText}>
          {taskText || '（子任务过程）'}
        </Typography.Text>
        <span
          style={{
            flexShrink: 0,
            fontSize: 12,
            color: running ? token.colorSuccess : run?.status === 'failed' || run?.status === 'interrupted' ? token.colorError : token.colorTextTertiary,
          }}
        >
          {run ? RUN_STATUS_LABELS[run.status] : ''}
          {run && run.etaActualMs > 0 ? ` ${formatDuration(run.etaActualMs)}` : ''}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 8 }} ref={scrollRef} onScroll={onDockScroll}>
        {/* 内容层恒挂载（RO 观察本层高度，空提示↔流渲染互切不换观察目标）；gap/块间距对齐中栏内容层 */}
        <div ref={contentRef} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {items.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {running ? '正在执行，过程即将出现…' : '暂无过程记录（该类型子任务不记录过程明细）'}
            </Typography.Text>
          ) : (
            <AgentStreamView items={items} onRespond={() => undefined} active={running} />
          )}
        </div>
      </div>
    </div>
  );
}

/** dock tab 文案：类型徽标 + 摘要（截断）+ 运行中圆点；tooltip=所属会话（归属双保险） */
function TabLabel({ title, kind, running, sessionTitle }: { title: string; kind?: RunInfo['kind']; running: boolean; sessionTitle: string }) {
  const { token } = theme.useToken();
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: 220, verticalAlign: 'middle' }}
      title={`${kind ? `${RUN_KIND_LABELS[kind]} · ` : ''}${title}\n所属会话：${sessionTitle}`}
    >
      {kind ? (
        <Tag color={runKindColor(kind)} style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px', paddingInline: 4, flexShrink: 0 }}>
          {RUN_KIND_LABELS[kind]}
        </Tag>
      ) : null}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{title || '子任务'}</span>
      {running ? (
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: 3, background: token.colorSuccess, flexShrink: 0 }} />
      ) : null}
    </span>
  );
}

/**
 * 右栏内容坞本体：antd Tabs（editable-card=可关闭、无 + 号）。
 * 无 tab 时调用方不渲染本组件；本组件只负责「当前会话的 tab 条 + 内容」。
 */
export function AgentRightDock({ session, runs }: AgentRightDockProps) {
  const allTabs = useAgentStore((s) => s.dockTabs);
  const activeBySession = useAgentStore((s) => s.dockActiveBySession);
  const closeDockTab = useAgentStore((s) => s.closeDockTab);
  const setDockActive = useAgentStore((s) => s.setDockActive);
  const setDockCollapsed = useAgentStore((s) => s.setDockCollapsed);

  // 会话归属/隔离：只取当前会话的 tab（切会话=整条 tab 条切换）
  const tabs = useMemo(() => allTabs.filter((t) => t.sessionId === session.id), [allTabs, session.id]);
  // 激活项兜底：记录的 key 不在本会话 tab 集 → 取最后一个（关 tab 后的过渡态）
  const requested = activeBySession[session.id] ?? null;
  const activeKey = requested && tabs.some((t) => t.key === requested) ? requested : (tabs[tabs.length - 1]?.key ?? undefined);

  const items = tabs.map((tab) => {
    const run = runs.find((r) => r.id === tab.runId);
    return {
      key: tab.key,
      closable: true,
      label: <TabLabel title={tab.title} kind={run?.kind} running={run?.status === 'running'} sessionTitle={session.title} />,
      children: <RunProcessPanel runId={tab.runId} run={run} />,
    };
  });

  return (
    <Tabs
      className="agent-dock-tabs"
      type="editable-card"
      hideAdd
      size="small"
      activeKey={activeKey}
      onChange={(key) => setDockActive(session.id, key)}
      onEdit={(key, action) => {
        if (action === 'remove') closeDockTab(String(key));
      }}
      tabBarExtraContent={
        <Button
          variant="text"
          size="small"
          icon={<PanelRightClose size={15} aria-hidden />}
          onClick={() => setDockCollapsed(true)}
          title="收起右栏"
        />
      }
      items={items}
    />
  );
}