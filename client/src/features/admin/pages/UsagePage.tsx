/**
 * PAD-12 用量与配额（D10 阶段一务实版，路由 /admin/usage）：
 * - 周期切换（7/14/30 天）+ 总计卡（requests/prompt/completion/tokens）
 * - 按日表格（requests/tokens 双列）+ 按 tier / 按 scene 两维汇总
 * - 数据源标注：PG（ai_usage_hourly）/ memory（网关 Meter 快照——无历史日，当日为准）
 * - 六态：loading 骨架 / empty（暂无用量）/ error 重试 / offline 遮罩 / forbidden 2003
 */

import { useState } from 'react';
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
    <div className="admin-usage">
      <header className="admin-page__header">
        <h2 className="admin-page__title">AI 用量</h2>
        {data ? (
          <span className="admin-page__meta">
            统计时点 {new Date(data.as_of).toLocaleString('zh-CN')} · 数据源：{data.mode === 'pg' ? 'ai_usage_hourly' : '网关 Meter 快照（内存模式，当日）'}
          </span>
        ) : null}
      </header>

      <div className="admin-toolbar">
        <div className="admin-toolbar__filters" data-testid="admin-usage-days">
          {DAY_OPTIONS.map((d) => (
            <button key={d} type="button" className={`admin-chip${days === d ? ' admin-chip--active' : ''}`} onClick={() => setDays(d)}>
              近 {d} 天
            </button>
          ))}
        </div>
      </div>

      <StateView
        state={state}
        skeleton={<SkeletonBlock height={320} />}
        emptyText="暂无用量数据（经 AI 网关发起 chat/embeddings 后计入）"
        error={query.error}
        onRetry={() => void query.refetch()}
        forbiddenText="需要 admin:usage:read 权限"
      >
        <div className="admin-cards admin-cards--usage">
          <div className="admin-card admin-card--ai">
            <div className="admin-card__icon" aria-hidden>
              <Zap size={18} strokeWidth={1.8} />
            </div>
            <div className="admin-card__body">
              <div className="admin-card__title">总请求</div>
              <div className="admin-card__value" data-testid="admin-usage-total-requests">
                {fmt(data?.total.requests)}
              </div>
            </div>
          </div>
          <div className="admin-card">
            <div className="admin-card__body">
              <div className="admin-card__title">prompt tokens</div>
              <div className="admin-card__value">{fmt(data?.total.prompt_tokens)}</div>
            </div>
          </div>
          <div className="admin-card">
            <div className="admin-card__body">
              <div className="admin-card__title">completion tokens</div>
              <div className="admin-card__value">{fmt(data?.total.completion_tokens)}</div>
            </div>
          </div>
          <div className="admin-card admin-card--ai">
            <div className="admin-card__body">
              <div className="admin-card__title">total tokens</div>
              <div className="admin-card__value" data-testid="admin-usage-total-tokens">
                {fmt(data?.total.total_tokens)}
              </div>
            </div>
          </div>
        </div>

        <section className="admin-panel">
          <div className="admin-panel__title">按日</div>
          <table className="admin-table" data-testid="admin-usage-daily">
            <thead>
              <tr>
                <th>日期</th>
                <th>requests</th>
                <th>prompt tokens</th>
                <th>completion tokens</th>
                <th>total tokens</th>
              </tr>
            </thead>
            <tbody>
              {(data?.daily ?? []).map((d) => (
                <tr key={d.date} data-testid={`admin-usage-row-${d.date}`}>
                  <td className="admin-mono">{d.date}</td>
                  <td>{fmt(d.requests)}</td>
                  <td>{fmt(d.prompt_tokens)}</td>
                  <td>{fmt(d.completion_tokens)}</td>
                  <td>{fmt(d.total_tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <div className="admin-usage__dims">
          <section className="admin-panel">
            <div className="admin-panel__title">按 tier 汇总</div>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>tier</th>
                  <th>requests</th>
                  <th>total tokens</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_tier ?? []).map((t) => (
                  <tr key={t.key}>
                    <td className="admin-mono">{t.key}</td>
                    <td>{fmt(t.requests)}</td>
                    <td>{fmt(t.total_tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="admin-panel">
            <div className="admin-panel__title">按 scene 汇总</div>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>scene</th>
                  <th>requests</th>
                  <th>total tokens</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_scene ?? []).map((t) => (
                  <tr key={t.key}>
                    <td className="admin-mono">{t.key}</td>
                    <td>{fmt(t.requests)}</td>
                    <td>{fmt(t.total_tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
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
