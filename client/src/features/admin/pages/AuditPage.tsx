/**
 * PAD-11 审计中心（D10 阶段一务实版，路由 /admin/audit）：
 * - 时间线列表（id 倒序）：操作人/动作（中文标签）/对象/detail 摘要/时间
 * - cursor 无限翻页（加载更多）；管理写操作后经 hooks 前缀失效自动刷新
 * - 六态：loading 骨架 / empty（暂无管理操作）/ error 重试（保留过滤条件）/
 *   offline 只读 / forbidden 2003 / degraded（阶段一无哈希链校验任务提示黄条）
 * D26-O2 补充：时间线→antd Timeline（自研 admin-timeline 样式退役）。
 */

import { Flex, Timeline, Typography } from 'antd';
import { RefreshCw } from 'lucide-react';
import { ApiError } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { StateView, type ViewStateOrOk } from '../../../shared/ui/StateView';
import { useConnectionStore } from '../../../shared/store/connection';
import { useAudit } from '../api/hooks';
import { AUDIT_ACTION_LABEL, type AuditItem } from '../model/types';

export function AuditPage() {
  const query = useAudit();
  const connStatus = useConnectionStore((s) => s.status);

  const items: AuditItem[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  const lastPage = query.data?.pages[query.data.pages.length - 1];

  const state: ViewStateOrOk = query.isPending
    ? 'loading'
    : query.isError
      ? query.error instanceof ApiError && query.error.code === 2003
        ? 'forbidden'
        : 'error'
      : items.length === 0
        ? 'empty'
        : connStatus === 'offline'
          ? 'offline'
          : 'ok';

  return (
    <div data-testid="admin-audit">
      <Flex align="center" gap={8} style={{ marginBottom: 16 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          审计日志
        </Typography.Title>
        <Typography.Text type="secondary">本租户全部管理写操作（禁用/启用/词库变更）自动留痕</Typography.Text>
        <Button variant="text" onClick={() => void query.refetch()} title="刷新" icon={<RefreshCw size={14} />} />
      </Flex>

      <StateView
        state={state}
        skeleton={<SkeletonList count={8} />}
        emptyText="暂无管理操作记录"
        error={query.error}
        onRetry={() => void query.refetch()}
        forbiddenText="需要 admin:audit:read 权限"
      >
        <Timeline
          data-testid="admin-audit-list"
          items={items.map((it) => ({
            key: it.id,
            children: (
              <div data-testid="admin-audit-item">
                <Flex wrap="wrap" gap={8} align="baseline">
                  <Typography.Text strong>{it.operator_name}</Typography.Text>
                  <Typography.Text>{AUDIT_ACTION_LABEL[it.action] ?? it.action}</Typography.Text>
                  <Typography.Text code>{it.target}</Typography.Text>
                  <Typography.Text type="secondary">{new Date(it.created_at).toLocaleString('zh-CN')}</Typography.Text>
                </Flex>
                {it.detail && Object.keys(it.detail).length > 0 ? (
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
                    {JSON.stringify(it.detail)}
                  </Typography.Paragraph>
                ) : null}
              </div>
            ),
          }))}
        />
        {lastPage?.has_more && lastPage.next_cursor ? (
          <Flex justify="center" style={{ marginTop: 8 }}>
            <Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              加载更多
            </Button>
          </Flex>
        ) : null}
      </StateView>
    </div>
  );
}
