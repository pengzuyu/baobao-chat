/**
 * 文章阅读页（D24）：markdown 全文渲染（chunk 拼接+MarkdownText 增强）+打开即 view 上报
 * （作者本人服务端短路）+大纲锚条+维度徽章/作者/时间/浏览量；砍摄入状态/重摄入/分块流水
 * （管线是基础设施，读者无感）。「引用到 Agent 输入框」bus 桥保留（成本极低且与 AI 定位呼应）。
 */

import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Eye } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fetchChunks, fetchDoc, fetchOutline } from '../api/kb';
import { useViewDoc } from '../api/hooks';
import { qk } from '../../../shared/api/keys';
import { MarkdownText } from '../../../shared/components/MarkdownText';
import { StateView } from '../../../shared/ui/StateView';
import { SkeletonBlock, SkeletonList } from '../../../shared/ui/Skeleton';
import { formatListTime } from '../../../shared/utils/time';
import { pushKbRecent } from './KbHomePage';

export function ArticlePage() {
  const { docId = '' } = useParams();
  const navigate = useNavigate();

  const doc = useQuery({ queryKey: qk.kb.doc(docId), queryFn: () => fetchDoc(docId), enabled: !!docId });
  const chunks = useQuery({ queryKey: qk.kb.chunks(docId), queryFn: () => fetchChunks(docId), enabled: !!docId });
  const outline = useQuery({
    queryKey: [...qk.kb.chunks(docId), 'outline'],
    queryFn: () => fetchOutline(docId),
    enabled: !!docId,
  });
  const view = useViewDoc();

  // 打开即上报（含作者本人——服务端短路；日去重幂等）+ 最近查看落本地
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
      <div className="kb-article__topbar">
        <button type="button" className="kb-link-btn" onClick={() => navigate(-1)}>
          <ArrowLeft size={14} /> 返回
        </button>
      </div>
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
                    onClick={() => document.querySelector(`[data-chunk-seq="${o.seq}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
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
                    {doc.data.space_type === 'personal' ? '我的笔记' : '公司知识库'}
                  </span>
                  <span>作者 {doc.data.created_by}</span>
                  <span>{formatListTime(doc.data.created_at)}</span>
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
