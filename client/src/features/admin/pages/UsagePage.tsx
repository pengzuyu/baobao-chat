/**
 * PAD-12 用量与配额（D10 阶段一务实版，路由 /admin/usage）：
 * - 周期切换（7/14/30 天）+ 总计卡（requests/prompt/completion/tokens）
 * - 按日表格（requests/tokens 双列）+ 按 tier / 按 scene 两维汇总
 * - 数据源标注：PG（ai_usage_hourly）/ memory（网关 Meter 快照——无历史日，当日为准）
 * - 六态：loading 骨架 / empty（暂无用量）/ error 重试 / offline 遮罩 / forbidden 2003
 * D26-O2 补充：总计卡→antd Card+Statistic、面板→Card、周期→Segmented（自研样式退役）。
 */

import { useState } from 'react';
import { Card, Flex, Segmented, Statistic, Table, Typography } from 'antd';
import { Zap } from 'lucide-react';
import { ApiError } from '../../../shared/api/http';
import { SkeletonBlock } from '../../../shared/ui/Skeleton';
import { StateView, type ViewStateOrOk } from '../../../shared/ui/StateView';
import { useConnectionStore } from '../../../shared/store/connection';
import { useUsage } from '../api/hooks';

const DAY_OPTIONS = [7, 14, 30] as const;

export function UsagePage() {
  const [days, setDays] = useState<number>(7);
  const query = useUsage(days);
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
        : data && data.daily.length === 0 && data.total.requests === 0
          ? 'empty'
          : 'ok';

  return (
    <div data-testid="admin-usage">
      <Flex align="center" gap={8} style={{ marginBottom: 16 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          AI 用量
        </Typography.Title>
        {data ? (
          <Typography.Text type="secondary">
            统计时点 {new Date(data.as_of).toLocaleString('zh-CN')} · 数据源：{data.mode === 'pg' ? 'ai_usage_hourly' : '网关 Meter 快照（内存模式，当日）'}
          </Typography.Text>
        ) : null}
      </Flex>

      <Flex gap={8} style={{ marginBottom: 16 }} data-testid="admin-usage-days">
        <Segmented
          value={days}
          onChange={(v) => setDays(v as number)}
          options={DAY_OPTIONS.map((d) => ({ value: d, label: `近 ${d} 天` }))}
        />
      </Flex>

      <StateView
        state={state}
        skeleton={<SkeletonBlock height={320} />}
        emptyText="暂无用量数据（经 AI 网关发起 chat/embeddings 后计入）"
        error={query.error}
        onRetry={() => void query.refetch()}
        forbiddenText="需要 admin:usage:read 权限"
      >
        <Flex wrap="wrap" gap={12} style={{ marginBottom: 16 }}>
          <Card size="small" style={{ width: 200 }}>
            <Flex align="center" gap={8}>
              <Zap size={18} strokeWidth={1.8} />
              <Statistic title="总请求" value={fmt(data?.total.requests)} />
            </Flex>
          </Card>
          <Card size="small" style={{ width: 200 }}>
            <Statistic title="prompt tokens" value={fmt(data?.total.prompt_tokens)} />
          </Card>
          <Card size="small" style={{ width: 200 }}>
            <Statistic title="completion tokens" value={fmt(data?.total.completion_tokens)} />
          </Card>
          <Card size="small" style={{ width: 200 }}>
            <Statistic title="total tokens" value={fmt(data?.total.total_tokens)} />
          </Card>
        </Flex>

        <Card size="small" title="按日" style={{ marginBottom: 16 }}>
          <Table
            rowKey="date"
            size="small"
            data-testid="admin-usage-daily"
            dataSource={data?.daily ?? []}
            pagination={false}
            onRow={(d) => ({ 'data-testid': `admin-usage-row-${d.date}` } as React.HTMLAttributes<HTMLTableRowElement>)}
            columns={[
              { title: '日期', dataIndex: 'date', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
              { title: 'requests', dataIndex: 'requests', render: (v: number) => fmt(v) },
              { title: 'prompt tokens', dataIndex: 'prompt_tokens', render: (v: number) => fmt(v) },
              { title: 'completion tokens', dataIndex: 'completion_tokens', render: (v: number) => fmt(v) },
              { title: 'total tokens', dataIndex: 'total_tokens', render: (v: number) => fmt(v) },
            ]}
          />
        </Card>

        <Flex gap={12} wrap="wrap">
          <Card size="small" title="按 tier 汇总" style={{ flex: 1, minWidth: 280 }}>
            <Table
              rowKey="key"
              size="small"
              dataSource={data?.by_tier ?? []}
              pagination={false}
              columns={[
                { title: 'tier', dataIndex: 'key', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
                { title: 'requests', dataIndex: 'requests', render: (v: number) => fmt(v) },
                { title: 'total tokens', dataIndex: 'total_tokens', render: (v: number) => fmt(v) },
              ]}
            />
          </Card>
          <Card size="small" title="按 scene 汇总" style={{ flex: 1, minWidth: 280 }}>
            <Table
              rowKey="key"
              size="small"
              dataSource={data?.by_scene ?? []}
              pagination={false}
              columns={[
                { title: 'scene', dataIndex: 'key', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
                { title: 'requests', dataIndex: 'requests', render: (v: number) => fmt(v) },
                { title: 'total tokens', dataIndex: 'total_tokens', render: (v: number) => fmt(v) },
              ]}
            />
          </Card>
        </Flex>
      </StateView>
    </div>
  );
}

function fmt(v: number | undefined): string {
  if (v === undefined) return '—';
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}万`;
  return String(v);
}
