/**
 * PAD-11 审计中心（D10 阶段一务实版，路由 /admin/audit）：
 * - 时间线列表（id 倒序）：操作人/动作（中文标签）/对象/detail 摘要/时间
 * - cursor 无限翻页（加载更多）；管理写操作后经 hooks 前缀失效自动刷新
 * - 六态：loading 骨架 / empty（暂无管理操作）/ error 重试（保留过滤条件）/
 *   offline 只读 / forbidden 2003 / degraded（阶段一无哈希链校验任务提示黄条）
 */

import { Clock, RefreshCw } from 'lucide-react';
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
    <div className="admin-audit">
      <header className="admin-page__header">
        <h2 className="admin-page__title">审计日志</h2>
        <span className="admin-page__meta">本租户全部管理写操作（禁用/启用/词库变更）自动留痕</span>
        <Button variant="text" onClick={() => void query.refetch()} title="刷新">
          <RefreshCw size={14} />
        </Button>
      </header>

      <StateView
        state={state}
        skeleton={<SkeletonList count={8} />}
        emptyText="暂无管理操作记录"
        error={query.error}
        onRetry={() => void query.refetch()}
        forbiddenText="需要 admin:audit:read 权限"
      >
        <div className="admin-timeline" data-testid="admin-audit-list">
          {items.map((it) => (
            <div key={it.id} className="admin-timeline__item" data-testid="admin-audit-item">
              <div className="admin-timeline__dot" aria-hidden />
              <div className="admin-timeline__body">
                <div className="admin-timeline__head">
                  <span className="admin-timeline__op">{it.operator_name}</span>
                  <span className="admin-timeline__action">{AUDIT_ACTION_LABEL[it.action] ?? it.action}</span>
                  <span className="admin-mono admin-timeline__target">{it.target}</span>
                  <span className="admin-timeline__time">
                    <Clock size={12} aria-hidden /> {new Date(it.created_at).toLocaleString('zh-CN')}
                  </span>
                </div>
                {it.detail && Object.keys(it.detail).length > 0 ? (
                  <div className="admin-timeline__detail">{JSON.stringify(it.detail)}</div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        {lastPage?.has_more && lastPage.next_cursor ? (
          <div className="admin-loadmore">
            <Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              加载更多
            </Button>
          </div>
        ) : null}
      </StateView>
    </div>
  );
}
