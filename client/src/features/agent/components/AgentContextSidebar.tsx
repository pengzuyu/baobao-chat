/**
 * 工作台右栏：上下文栏（D33 §3.6 Tabs 化：概览/运行/详情/检查点）：
 * - 概览=会话信息（工作区/模式/模型档位/最近用量/结论摘要）
 * - 运行=run 记录（D16 §3.1；**点行打开运行详情**）
 * - 详情=运行详情（D33 新）：子 agent 过程流——AgentStreamView 与中栏同款渲染
 *   （「与主 agent 一样，但不在一个窗口」）；sideStreams 直播 / run.history 回放；
 *   delegate 优先 childSessionRef 的会话历史。activeRunView 置位时自动切到本 tab
 * - 检查点时间线（PAG-06 简版）
 * 记忆侧写 tab 已退役（记忆由平台后台组织，不做用户浏览面）。
 * D26-O4：分区→Card、KV→Descriptions、清单→List、chip→Tag；
 * D33 aside 宽度：运行详情激活时页面侧加宽至 480（本组件不管宽，页面定）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Descriptions, Flex, List, Space, Spin, Tabs, Tag, Typography, theme } from 'antd';
import { useAgentStore, type CheckpointItem } from '../store/agent';
import { AGENT_MODE_OPTIONS, MODEL_TIER_LABELS, SESSION_STATUS_LABELS } from '../bridge/types';
import type { AgentSessionMeta, RunInfo } from '../bridge/types';
import { AgentStreamView } from './stream/AgentStreamView';

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

/** run 类型徽标色（原 agent-run-item__kind--delegate 主色口径） */
function runKindColor(kind: RunInfo['kind']): string | undefined {
  return kind === 'delegate' ? 'blue' : undefined;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '';
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

interface AgentContextSidebarProps {
  session: AgentSessionMeta;
  model: 'fast' | 'strong' | 'auto';
  checkpoints: CheckpointItem[];
  usage?: { in: number; out: number };
  pendingCount: number;
  /** run 记录（D16 §3.1；新建在末尾展示最近 8 条倒序） */
  runs: RunInfo[];
}

/** 运行详情视图（D33：子 agent 过程流——侧栏复用主渲染器） */
function RunDetailView({ runs }: { runs: RunInfo[] }) {
  const { token } = theme.useToken();
  const activeRunView = useAgentStore((s) => s.activeRunView);
  const sideItems = useAgentStore((s) => (s.activeRunView ? s.sideStreams[s.activeRunView] : undefined));
  const taskRuns = useAgentStore((s) => s.taskRuns);
  const closeRunView = useAgentStore((s) => s.closeRunView);
  const loadHistoryIfEmpty = useAgentStore((s) => s.loadHistoryIfEmpty);

  const run = useMemo(
    () => runs.find((r) => r.id === activeRunView) ?? taskRuns.find((r) => r.id === activeRunView) ?? null,
    [runs, taskRuns, activeRunView],
  );
  // delegate 优先子进程会话历史（--resume 句柄，D16）；probe/expert/team 走 run 流
  const childRef = run?.kind === 'delegate' && run.childSessionRef ? run.childSessionRef : '';
  const childItems = useAgentStore((s) => (childRef ? s.streams[childRef] : undefined));
  useEffect(() => {
    if (childRef) void loadHistoryIfEmpty(childRef);
  }, [childRef, loadHistoryIfEmpty]);

  if (!activeRunView) return null;
  const items = run?.kind === 'delegate' && (childItems?.length ?? 0) > 0 ? childItems! : (sideItems ?? []);
  const taskText = items[0]?.kind === 'user' ? items[0].text : (run?.summary ?? '');
  const running = run?.status === 'running';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <Flex justify="space-between" align="center" gap={8} style={{ minWidth: 0 }}>
        <Space size={6} style={{ minWidth: 0 }}>
          {run ? (
            <Tag color={runKindColor(run.kind)} style={{ marginInlineEnd: 0 }}>
              {RUN_KIND_LABELS[run.kind]}
            </Tag>
          ) : null}
          <Typography.Text ellipsis style={{ fontSize: 12, minWidth: 0 }} title={taskText}>
            {taskText || activeRunView}
          </Typography.Text>
        </Space>
        <Space size={6} style={{ flexShrink: 0 }}>
          {running ? <Spin size="small" aria-hidden /> : null}
          <span style={{ fontSize: 12, color: run ? (running ? token.colorSuccess : run.status === 'failed' || run.status === 'interrupted' ? token.colorError : token.colorTextTertiary) : token.colorTextTertiary }}>
            {run ? RUN_STATUS_LABELS[run.status] : ''}
            {run && run.etaActualMs > 0 ? ` ${formatDuration(run.etaActualMs)}` : ''}
          </span>
          <Typography.Link style={{ fontSize: 12 }} onClick={() => closeRunView()}>
            关闭
          </Typography.Link>
        </Space>
      </Flex>
      <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 8, minWidth: 0 }}>
        <AgentStreamView items={items} onRespond={() => undefined} active={running} />
      </div>
    </div>
  );
}

export function AgentContextSidebar({ session, model, checkpoints, usage, pendingCount, runs }: AgentContextSidebarProps) {
  const { token } = theme.useToken();
  const [activeKey, setActiveKey] = useState('overview');
  const openRunView = useAgentStore((s) => s.openRunView);
  const activeRunView = useAgentStore((s) => s.activeRunView);
  const keyRef = useRef(activeKey);
  keyRef.current = activeKey;

  // 子任务卡/委派卡「查看过程」置位 → 自动切运行详情 tab；关闭 → 回概览
  useEffect(() => {
    if (activeRunView) setActiveKey('runDetail');
    else if (keyRef.current === 'runDetail') setActiveKey('overview');
  }, [activeRunView]);

  const modeLabel = AGENT_MODE_OPTIONS.find((m) => m.value === session.mode)?.label ?? session.mode;

  /** run 状态文字色（运行=成功色/失败=错误色，其余次要） */
  const runStatusStyle = (status: RunInfo['status']): React.CSSProperties =>
    status === 'running'
      ? { color: token.colorSuccess }
      : status === 'failed' || status === 'interrupted'
        ? { color: token.colorError }
        : { color: token.colorTextTertiary };

  return (
    <Tabs
      size="small"
      activeKey={activeKey}
      onChange={setActiveKey}
      style={{ padding: '4px 8px', minWidth: 0 }}
      items={[
        {
          key: 'overview',
          label: '概览',
          children: (
            <Card size="small" title="会话信息">
              <Descriptions
                size="small"
                column={1}
                items={[
                  {
                    key: 'ws',
                    label: '工作区',
                    children: <span title={session.workspace || '日常对话（无工作目录）'}>{session.workspace || '日常对话 · 无工作目录'}</span>,
                  },
                  { key: 'status', label: '状态', children: SESSION_STATUS_LABELS[session.status] },
                  { key: 'mode', label: '权限模式', children: modeLabel },
                  { key: 'model', label: '模型档位', children: MODEL_TIER_LABELS[model] },
                  ...(usage
                    ? [{ key: 'usage', label: '最近用量', children: `in ${usage.in.toLocaleString()} / out ${usage.out.toLocaleString()} tokens` }]
                    : []),
                  ...(session.summary ? [{ key: 'summary', label: '结论摘要', children: session.summary }] : []),
                ]}
              />
            </Card>
          ),
        },
        {
          key: 'runs',
          label: '运行',
          children:
            runs.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                暂无子任务（探查/专家/委派启动后在此可见）
              </Typography.Text>
            ) : (
              <List
                size="small"
                dataSource={[...runs].reverse().slice(0, 8)}
                renderItem={(r) => (
                  <List.Item
                    style={{ padding: '4px 0', fontSize: 12, cursor: 'pointer' }}
                    onClick={() => openRunView(r.id)}
                    title={`${r.id} · ${r.defRef}${r.summary ? ` · ${r.summary.slice(0, 120)}` : ''}（点击查看过程）`}
                  >
                    <Flex justify="space-between" align="center" gap={8} style={{ width: '100%', minWidth: 0 }}>
                      <Space size={6} style={{ minWidth: 0 }}>
                        <Tag color={runKindColor(r.kind)} style={{ marginInlineEnd: 0 }}>
                          {RUN_KIND_LABELS[r.kind]}
                        </Tag>
                        <Typography.Text ellipsis style={{ fontSize: 12 }}>
                          {r.defRef.replace('backend:', '').replace('builtin.', '')}
                        </Typography.Text>
                      </Space>
                      <span style={{ flexShrink: 0, fontSize: 12, ...runStatusStyle(r.status) }}>
                        {RUN_STATUS_LABELS[r.status]}
                        {r.status === 'running' && r.etaHintMs > 0 ? ` ~${formatDuration(r.etaHintMs)}` : ''}
                        {r.etaActualMs > 0 ? ` ${formatDuration(r.etaActualMs)}` : ''}
                      </span>
                    </Flex>
                  </List.Item>
                )}
              />
            ),
        },
        // 运行详情（D33）：activeRunView 置位才出现
        ...(activeRunView
          ? [
              {
                key: 'runDetail',
                label: '详情',
                children: <RunDetailView runs={runs} />,
              },
            ]
          : []),
        {
          key: 'checkpoints',
          label: (
            <Space size={4}>
              检查点
              {pendingCount > 0 ? <Tag color="warning" style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px', paddingInline: 4 }}>{pendingCount}</Tag> : null}
            </Space>
          ),
          children:
            checkpoints.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                暂无检查点（修改类工具执行前自动创建）
              </Typography.Text>
            ) : (
              <List
                size="small"
                dataSource={checkpoints}
                renderItem={(cp) => (
                  <List.Item style={{ padding: '3px 4px', fontSize: 12 }}>
                    <Flex align="center" gap={8} style={{ width: '100%', minWidth: 0 }}>
                      <Typography.Text code style={{ fontSize: 12, maxWidth: 110 }} ellipsis title={cp.id}>
                        {cp.id.replace(/^cp-/, '')}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
                        {formatClock(cp.createdAt)}
                      </Typography.Text>
                      <Typography.Text ellipsis style={{ fontSize: 12, minWidth: 0, flex: 1 }}>
                        {cp.reason}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
                        {cp.filesChanged.length} 文件
                      </Typography.Text>
                    </Flex>
                  </List.Item>
                )}
              />
            ),
        },
      ]}
    />
  );
}
