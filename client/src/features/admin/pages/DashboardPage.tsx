/**
 * PAD-02 仪表盘（D10 阶段一务实版，路由 /admin）：
 * - 六指标卡：用户总数/在线数(hub 连接)/今日会话/今日消息/KB 文档/文件存储
 * - 今日 AI 调用卡（requests/tokens）+ 近 7 日 tokens 趋势简表
 * - 六态：loading 指标卡骨架 / empty（无数据卡显示 —）/ error 单页重试 /
 *   offline 缓存+遮罩 / forbidden（2003 整页锁）/ degraded（指标源缺失→0 值卡注明）
 * - 统计时点标注（as_of，PAD-02"统计时点"语义）
 * D26-O2 补充：指标卡→antd Card+Statistic、面板→Card、趋势占比→Progress（自研样式退役）。
 */

import { Card, Flex, Progress, Statistic, Table, Typography } from 'antd';
import { Activity, BrainCircuit, HardDrive, MessageSquare, MessagesSquare, Users, Zap } from 'lucide-react';
import { ApiError } from '../../../shared/api/http';
import { formatBytes } from '../../../shared/utils/format';
import { SkeletonBlock } from '../../../shared/ui/Skeleton';
import { StateView, type ViewStateOrOk } from '../../../shared/ui/StateView';
import { useConnectionStore } from '../../../shared/store/connection';
import { useDashboard } from '../api/hooks';

/** 指标卡元数据（标题/图标/取值） */
interface CardDef {
  key: string;
  title: string;
  icon: typeof Users;
  value: string;
  hint?: string;
}

export function DashboardPage() {
  const query = useDashboard();
  const connStatus = useConnectionStore((s) => s.status);
  const data = query.data;

  const state: ViewStateOrOk = query.isPending
    ? 'loading'
    : query.isError
      ? query.error instanceof ApiError && query.error.code === 2003
        ? 'forbidden'
        : 'error'
      : connStatus === 'offline'
        ? 'offline'
        : 'ok'; // 六指标恒渲染（无数据卡显示 —，PAD-02 degraded 语义）

  const d = data;
  const cards: CardDef[] = [
    { key: 'users', title: '用户总数', icon: Users, value: fmtNum(d?.users_total) },
    { key: 'online', title: '当前在线', icon: Activity, value: fmtNum(d?.online_now), hint: 'WS 连接数（含多端）' },
    { key: 'sessions', title: '今日会话', icon: MessageSquare, value: fmtNum(d?.sessions_today), hint: '今日有消息往来的会话' },
    { key: 'msgs', title: '今日消息', icon: MessagesSquare, value: fmtNum(d?.msgs_today) },
    { key: 'kb', title: 'KB 文档', icon: BrainCircuit, value: fmtNum(d?.kb_docs) },
    { key: 'storage', title: '文件存储', icon: HardDrive, value: d ? formatBytes(d.file_storage_bytes) : '—' },
  ];

  const trend = d?.ai_tokens_trend ?? [];
  const maxTokens = Math.max(1, ...trend.map((p) => p.total_tokens));

  return (
    <div data-testid="admin-dashboard">
      <Flex align="center" gap={8} style={{ marginBottom: 16 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          仪表盘
        </Typography.Title>
        {d ? <Typography.Text type="secondary">统计时点 {new Date(d.as_of).toLocaleString('zh-CN')}</Typography.Text> : null}
      </Flex>
      <StateView
        state={state}
        skeleton={<SkeletonBlock height={280} />}
        emptyText="暂无管理数据"
        error={query.error}
        onRetry={() => void query.refetch()}
        forbiddenText="需要管理员权限（admin:*）"
      >
        <Flex wrap="wrap" gap={12} style={{ marginBottom: 16 }}>
          {cards.map((c) => (
            <Card key={c.key} size="small" style={{ width: 200 }} data-testid={`admin-card-${c.key}`}>
              <Flex align="center" gap={8}>
                <c.icon size={18} strokeWidth={1.8} />
                <Statistic title={c.title} value={c.value} />
              </Flex>
              {c.hint ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{c.hint}</Typography.Text> : null}
            </Card>
          ))}
          <Card size="small" style={{ width: 200 }} data-testid="admin-card-ai">
            <Flex align="center" gap={8}>
              <Zap size={18} strokeWidth={1.8} />
              <Statistic title="今日 AI 调用" value={fmtNum(d?.ai_today.requests)} />
            </Flex>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {fmtNum(d?.ai_today.total_tokens)} tokens
            </Typography.Text>
          </Card>
        </Flex>

        <Card size="small" title="近 7 日 AI tokens 趋势">
          {trend.length === 0 ? (
            <Typography.Text type="secondary">暂无用量数据（经网关发起 embed/chat 后计入）</Typography.Text>
          ) : (
            <Table
              rowKey="date"
              size="small"
              dataSource={trend}
              pagination={false}
              columns={[
                { title: '日期', dataIndex: 'date', width: 120 },
                { title: 'tokens', dataIndex: 'total_tokens', width: 120, render: (v: number) => fmtNum(v) },
                {
                  title: '占比',
                  key: 'bar',
                  render: (_, p) => <Progress percent={Math.max(2, Math.round((p.total_tokens / maxTokens) * 100))} showInfo={false} size="small" />,
                },
              ]}
            />
          )}
        </Card>
      </StateView>
    </div>
  );
}

/** 数值格式化（undefined → —；≥10000 缩写） */
function fmtNum(v: number | undefined): string {
  if (v === undefined) return '—';
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}万`;
  return String(v);
}
