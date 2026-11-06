/**
 * Agent 日报页（/agent/reports，D15 §3.2 内容形态；D08 未细化，按被动轨日报设计）：
 * - 列表：日期 + stats 概览行（会话数 / 工具调用 / 被拦截 / 文件变更 / 记忆沉淀）
 * - 点开当日 → markdown 渲染（会话数/工具排行/拦截/文件变更/记忆条目/会话明细表）
 * - report.daily 事件到达实时更新（同日覆盖，D15 §3.2 幂等）
 * - 六态：loading/empty/error/offline（本地数据照常）；forbidden 不适用
 */

import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { useConnectionStore } from '../../../shared/store/connection';
import { useAgentStore } from '../store/agent';
import { AgentSubNav } from '../components/AgentSubNav';
import { MarkdownText } from '../components/StreamMessage';

export function AgentReportsPage() {
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

  const listNode = (
    <div className="agent-report-list">
      {reports.map((r) => {
        const open = openDate === r.date;
        return (
          <section key={r.date} className={`agent-report-item${open ? ' agent-report-item--open' : ''}`}>
            <button type="button" className="agent-report-item__head" onClick={() => setOpenDate(open ? null : r.date)}>
              <ChevronRight size={13} className={`agent-report-item__chev${open ? ' agent-report-item__chev--open' : ''}`} aria-hidden />
              <span className="agent-report-item__date">{r.date}</span>
              <span className="agent-report-item__stats">
                <span>会话 {r.stats.sessions}</span>
                <span>工具 {r.stats.tools}</span>
                <span className={r.stats.blocked > 0 ? 'agent-report-item__stat--warn' : undefined}>拦截 {r.stats.blocked}</span>
                <span>文件 {r.stats.files}</span>
                <span>记忆 +{r.stats.memorySaved}</span>
              </span>
            </button>
            {open ? (
              <div className="agent-report-item__body">
                <MarkdownText text={r.markdown} />
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );

  return (
    <div className="agent-page">
      <AgentSubNav />
      <div className="agent-report-page">
        <header className="agent-report-head">
          <div>
            <h2 className="agent-report-head__title">Agent 日报</h2>
            <p className="agent-report-head__desc">
              活动日志确定性聚合的每日总结（D15 被动轨）：会话、工具、拦截、文件变更与当日新增记忆，全部本地生成。
            </p>
          </div>
        </header>
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
