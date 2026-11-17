/**
 * Agent 日报页（/agent/reports，D15 §3.2 内容形态；D08 未细化，按被动轨日报设计）：
 * - 列表：日期 + stats 概览行（会话数 / 工具调用 / 被拦截 / 文件变更 / 记忆沉淀）
 * - 点开当日 → markdown 渲染（会话数/工具排行/拦截/文件变更/记忆条目/会话明细表）
 * - report.daily 事件到达实时更新（同日覆盖，D15 §3.2 幂等）
 * - 六态：loading/empty/error/offline（本地数据照常）；forbidden 不适用
 * D26-O4：日报条目→antd Collapse（accordion 单开；agent-report-* 自研样式退役）。
 */

import { useEffect, useState } from 'react';
import { Collapse, Flex, Space, Typography, theme } from 'antd';
import type { CollapseProps } from 'antd';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { useConnectionStore } from '../../../shared/store/connection';
import { useAgentStore } from '../store/agent';
import { AgentSubNav } from '../components/AgentSubNav';
import { MarkdownText } from '../../../shared/components/MarkdownText';

export function AgentReportsPage() {
  const { token } = theme.useToken();
  const init = useAgentStore((s) => s.init);
  const reports = useAgentStore((s) => s.reports);
  const loading = useAgentStore((s) => s.reportsLoading);
  const error = useAgentStore((s) => s.reportsError);

  const [openDate, setOpenDate] = useState<string | null>(null);

  useEffect(() => {
    void init();
  }, [init]);
  // 默认展开最新一期（首次数据到达时）
  useEffect(() => {
    if (!openDate && reports.length > 0) setOpenDate(reports[0].date);
  }, [reports, openDate]);

  const connStatus = useConnectionStore((s) => s.status);
  const degradedText = useConnectionStore((s) => s.degradedText);

  const state: ViewState | 'ok' = loading
    ? 'loading'
    : error
      ? 'error'
      : reports.length === 0
        ? 'empty'
        : degradedText
          ? 'degraded'
          : connStatus === 'offline'
            ? 'offline'
            : 'ok';

  /** 头部：日期 + stats 概览（拦截>0 警示色，原 agent-report-item__stat--warn 口径） */
  const headOf = (r: (typeof reports)[number]) => (
    <Flex align="center" gap={8} style={{ minWidth: 0 }}>
      <Typography.Text strong style={{ fontSize: 14, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
        {r.date}
      </Typography.Text>
      <Space size={16} wrap style={{ marginLeft: 'auto', justifyContent: 'flex-end' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>会话 {r.stats.sessions}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>工具 {r.stats.tools}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12, color: r.stats.blocked > 0 ? token.colorWarning : undefined }}>
          拦截 {r.stats.blocked}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>文件 {r.stats.files}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>记忆 +{r.stats.memorySaved}</Typography.Text>
      </Space>
    </Flex>
  );

  const collapseItems: CollapseProps['items'] = reports.map((r) => ({
    key: r.date,
    label: headOf(r),
    children: <MarkdownText text={r.markdown} />,
  }));

  const listNode = (
    <Collapse
      size="small"
      accordion
      items={collapseItems}
      activeKey={openDate ?? undefined}
      onChange={(key) => setOpenDate(Array.isArray(key) ? (key[key.length - 1] ?? null) : (key || null))}
    />
  );

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <AgentSubNav />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          maxWidth: 860,
          width: '100%',
          margin: '0 auto',
        }}
      >
        <div>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Agent 日报
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 0, fontSize: 13, maxWidth: 560 }}>
            活动日志确定性聚合的每日总结（D15 被动轨）：会话、工具、拦截、文件变更与当日新增记忆，全部本地生成。
          </Typography.Paragraph>
        </div>
        {state === 'ok' ? (
          listNode
        ) : (
          <StateView
            state={state}
            skeleton={<SkeletonList count={4} />}
            error={new Error(error ?? '日报加载失败')}
            onRetry={() => void init()}
            emptyText="还没有日报：产生会话活动后自动生成"
            offlineText="离线中：日报为本地数据，可正常查看"
            degradedText={degradedText ?? undefined}
          >
            {listNode}
          </StateView>
        )}
      </div>
    </div>
  );
}
