/**
 * 工作台右栏：上下文栏（PAG-01 §3.1 E 区，可折叠）：
 * - 会话信息：工作区/模式/模型档位/最近一轮用量/结论摘要
 * - 检查点时间线（PAG-06 简版）：cp 短号 + 时间 + reason + 文件数
 * - 记忆侧写：最近沉淀的记忆条目（D15 主动轨）
 * D26-O4：分区→Card、KV→Descriptions、清单→List、chip→Tag（agent-side、agent-run-item、
 * agent-cp-item、agent-mem-chip 自研样式退役）。
 */

import { Link } from 'react-router-dom';
import { Card, Descriptions, Flex, List, Space, Tag, Typography, theme } from 'antd';
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

/** run 类型徽标色（原 agent-run-item__kind--delegate 主色口径） */
function runKindColor(kind: RunInfo['kind']): string | undefined {
  return kind === 'delegate' ? 'blue' : undefined;
}

/** 记忆类型徽标色（原 agent-mem-chip--* 四色口径） */
function memoryChipColor(type: MemoryEntry['type']): string | undefined {
  if (type === 'user') return 'blue';
  if (type === 'project') return 'green';
  if (type === 'feedback') return 'gold';
  return undefined;
}

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
  const { token } = theme.useToken();
  const modeLabel = AGENT_MODE_OPTIONS.find((m) => m.value === session.mode)?.label ?? session.mode;

  /** run 状态文字色（运行=成功色/失败=错误色，其余次要） */
  const runStatusStyle = (status: RunInfo['status']): React.CSSProperties =>
    status === 'running'
      ? { color: token.colorSuccess }
      : status === 'failed' || status === 'interrupted'
        ? { color: token.colorError }
        : { color: token.colorTextTertiary };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }}>
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

      <Card size="small" title="运行记录">
        {runs.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            暂无子任务（探查/专家/委派启动后在此可见）
          </Typography.Text>
        ) : (
          <List
            size="small"
            dataSource={[...runs].reverse().slice(0, 8)}
            renderItem={(r) => (
              <List.Item style={{ padding: '4px 0', fontSize: 12 }}>
                <Flex justify="space-between" align="center" gap={8} style={{ width: '100%', minWidth: 0 }} title={`${r.id} · ${r.defRef}${r.summary ? ` · ${r.summary.slice(0, 120)}` : ''}`}>
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
        )}
      </Card>

      <Card
        size="small"
        title={
          <Space size={8}>
            检查点时间线
            {pendingCount > 0 ? <Tag color="warning">{pendingCount} 待审批</Tag> : null}
          </Space>
        }
      >
        {checkpoints.length === 0 ? (
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
        )}
      </Card>

      <Card size="small" title="记忆侧写">
        {memories.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            还没有沉淀的记忆
          </Typography.Text>
        ) : (
          <List
            size="small"
            dataSource={memories.slice(0, 5)}
            renderItem={(m) => (
              <List.Item style={{ padding: '3px 0', fontSize: 12 }} title={m.hook}>
                <Space size={6} style={{ minWidth: 0 }}>
                  <Tag color={memoryChipColor(m.type)} style={{ marginInlineEnd: 0 }}>
                    {MEMORY_TYPE_LABELS[m.type]}
                  </Tag>
                  <Typography.Text ellipsis style={{ fontSize: 12 }}>
                    {m.title}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        )}
        <Link to="/agent/memory" style={{ fontSize: 12 }}>
          查看全部记忆 →
        </Link>
      </Card>
    </div>
  );
}
