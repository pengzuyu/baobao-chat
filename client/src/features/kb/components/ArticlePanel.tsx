/**
 * 文章内容面板（D24 真机修正轮 2026-11-13）：KbShell tab 容器内渲染——
 * 标题/维度徽章/作者/创建·更新时间/浏览量 + 大纲锚条 + markdown 全文；
 * 打开即 view 上报（作者本人服务端短路；日去重幂等）。由 pages/ArticlePage 抽组件化。
 */

import { useEffect } from 'react';
import { Eye } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fetchChunks, fetchDoc, fetchOutline } from '../api/kb';
import { useViewDoc } from '../api/hooks';
import { qk } from '../../../shared/api/keys';
import { MarkdownText } from '../../../shared/components/MarkdownText';
import { StateView } from '../../../shared/ui/StateView';
import { SkeletonBlock, SkeletonList } from '../../../shared/ui/Skeleton';
import { formatListTime } from '../../../shared/utils/time';
import { pushKbRecent } from '../pages/KbHomePage';

export function ArticlePanel(props: { docId: string }) {
  const { docId } = props;
  const doc = useQuery({ queryKey: qk.kb.doc(docId), queryFn: () => fetchDoc(docId), enabled: !!docId });
  const chunks = useQuery({ queryKey: qk.kb.chunks(docId), queryFn: () => fetchChunks(docId), enabled: !!docId });
  const outline = useQuery({
    queryKey: [...qk.kb.chunks(docId), 'outline'],
    queryFn: () => fetchOutline(docId),
    enabled: !!docId,
  });
  const view = useViewDoc();

  // 打开即上报（含作者本人——服务端短路）+ 最近查看落本地
  useEffect(() => {
    if (docId) void view.mutate(docId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);
  useEffect(() => {
    if (doc.data?.title && docId) pushKbRecent(docId, doc.data.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.data?.title]);

  const state: 'loading' | 'error' | 'ok' =
    doc.isPending || chunks.isPending ? 'loading' : doc.isError || chunks.isError ? 'error' : 'ok';

  return (
    <div className="kb-article" data-testid="kb-article">
      <StateView
        state={state}
        skeleton={
          <div className="kb-article__skeleton">
            <SkeletonBlock height={28} />
            <SkeletonList count={6} />
          </div>
        }
        error={doc.error ?? chunks.error}
        onRetry={() => {
          void doc.refetch();
          void chunks.refetch();
        }}
      >
        {doc.data ? (
          <div className="kb-article__layout">
            <aside className="kb-article__outline">
              <div className="kb-article__outline-head">大纲</div>
              {(outline.data ?? []).length > 0 ? (
                (outline.data ?? []).map((o) => (
                  <button
                    key={`${o.heading_path}-${o.seq}`}
                    type="button"
                    className="kb-article__outline-item"
                    onClick={() =>
                      document.querySelector(`[data-chunk-seq="${o.seq}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }
                  >
                    {o.heading_path}
                  </button>
                ))
              ) : (
                <span className="kb-article__outline-empty">（无大纲）</span>
              )}
            </aside>
            <article className="kb-article__main">
              <header className="kb-article__head">
                <h1 className="kb-article__title">{doc.data.title}</h1>
                <div className="kb-article__meta">
                  <span className={`kb-space-badge kb-space-badge--${doc.data.space_type ?? 'company'}`}>
                    {doc.data.space_type === 'personal' ? '我的文章' : '公司知识库'}
                  </span>
                  <span>作者 {doc.data.created_by}</span>
                  <span>创建 {formatListTime(doc.data.created_at)}</span>
                  <span>更新 {formatListTime(doc.data.updated_at)}</span>
                  <span className="kb-article__views">
                    <Eye size={13} /> {fmtViews(view.data?.view_count ?? doc.data.view_count ?? 0)}
                  </span>
                </div>
              </header>
              {chunks.data && chunks.data.length > 0 ? (
                <div className="kb-article__body">
                  {chunks.data.map((c) => (
                    <div key={c.seq} data-chunk-seq={c.seq} className="kb-article__chunk">
                      <MarkdownText text={c.content} />
                    </div>
                  ))}
                </div>
              ) : (
                <StateView state="empty" emptyText="文章内容为空" />
              )}
            </article>
          </div>
        ) : null}
      </StateView>
    </div>
  );
}

function fmtViews(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  return String(n);
}
