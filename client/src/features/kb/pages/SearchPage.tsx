/**
 * 检索结果页（D24）：/kb/search?q=——现 KbPage 内 SearchPanel 吸收为独立页面；
 * 命中卡文章化（标题+维度徽章+snippet 高亮+浏览量），点击跳阅读页锚点；
 * 展开上下文（seq 前后块）沿用；degraded 黄条（vector/reranker）与合规提示保留。
 */

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { fetchChunksAround, queryKb } from '../api/kb';
import type { KbChunk, KbQueryHit } from '../model/types';
import { HighlightText } from '../components/HighlightText';
import { StateView } from '../../../shared/ui/StateView';
import { SkeletonList } from '../../../shared/ui/Skeleton';

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const keyword = params.get('q') ?? '';
  const [input, setInput] = useState(keyword);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [aroundMap, setAroundMap] = useState<Record<string, KbChunk[]>>({});

  const search = useMutation({
    mutationFn: (kw: string) => queryKb({ keyword: kw, top_k: 10 }),
  });

  // 关键词变化即查（直接进入页面带 q 时触发一次）
  useState(() => {
    if (keyword) search.mutate(keyword);
  });

  const submit = () => {
    const kw = input.trim();
    if (!kw) return;
    setExpanded({});
    setAroundMap({});
    setParams({ q: kw });
    search.mutate(kw);
  };

  const toggleExpand = async (hit: KbQueryHit) => {
    const key = `${hit.doc_id}#${hit.chunk_seq}`;
    if (expanded[key]) {
      setExpanded((m) => ({ ...m, [key]: false }));
      return;
    }
    if (!aroundMap[key]) {
      try {
        const items = await fetchChunksAround(hit.doc_id, hit.chunk_seq);
        setAroundMap((m) => ({ ...m, [key]: items }));
      } catch {
        /* 展开失败静默（下有兜底空数组） */
      }
    }
    setExpanded((m) => ({ ...m, [key]: true }));
  };

  const items = search.data?.items ?? [];
  const degraded = search.data?.degraded ?? [];
  const state: 'loading' | 'error' | 'empty' | 'ok' = !keyword
    ? 'empty'
    : search.isPending
      ? 'loading'
      : search.isError
        ? 'error'
        : items.length === 0
          ? 'empty'
          : 'ok';

  return (
    <div className="kb-search-page" data-testid="kb-search-page">
      <div className="kb-search-page__bar">
        <Search size={16} className="kb-search-page__icon" />
        <input
          className="kb-search-page__input"
          value={input}
          placeholder="搜索公司知识"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          autoFocus
        />
        <button type="button" className="kb-search-page__btn" onClick={submit} disabled={!input.trim()}>
          搜索
        </button>
      </div>

      {state === 'ok' ? (
        <div className="kb-search-page__meta">
          命中 {items.length} · {search.data?.took_ms ?? 0}ms
        </div>
      ) : null}
      {degraded.includes('vector') ? (
        <div className="kb-degraded-bar">语义检索暂不可用，已切换关键词模式</div>
      ) : null}
      {degraded.includes('reranker') ? (
        <div className="kb-degraded-bar kb-degraded-bar--mild">重排服务暂不可用，已按融合序展示</div>
      ) : null}
      {search.data?.filtered_hint ? (
        <div className="kb-filtered-hint">⚠ {search.data.filtered_hint}（结果可能不完整）</div>
      ) : null}

      <StateView
        state={state}
        skeleton={<SkeletonList count={3} />}
        error={search.error}
        onRetry={() => keyword && search.mutate(keyword)}
        emptyText={keyword ? '未找到相关内容：尝试更换关键词' : '输入关键词开始搜索'}
      >
        <div className="kb-hit-list">
          {items.map((hit) => {
            const key = `${hit.doc_id}#${hit.chunk_seq}`;
            return (
              <div key={key} className="kb-hit-card" data-testid="kb-hit-card">
                <div className="kb-hit-card__head">
                  <span className={`kb-space-badge kb-space-badge--${hit.space_type}`}>
                    {hit.space_type === 'company' ? '公司' : '个人'}
                  </span>
                  <button type="button" className="kb-hit-card__title" onClick={() => navigate(`/kb/d/${hit.doc_id}`)}>
                    {hit.title}
                    {hit.heading_path ? ` · ${hit.heading_path}` : ''}
                  </button>
                  {hit.rerank_score ? (
                    <span className="kb-hit-card__score">{hit.rerank_score.toFixed(2)}</span>
                  ) : (
                    <span className="kb-hit-card__score">{hit.score.toFixed(4)}</span>
                  )}
                </div>
                <div className="kb-hit-card__snippet">
                  <HighlightText text={hit.snippet} ranges={hit.highlight} />
                </div>
                <div className="kb-hit-card__actions">
                  <button type="button" className="kb-link-btn" onClick={() => void toggleExpand(hit)}>
                    展开上下文
                  </button>
                  <button type="button" className="kb-link-btn" onClick={() => navigate(`/kb/d/${hit.doc_id}`)}>
                    阅读全文
                  </button>
                </div>
                {expanded[key] ? (
                  <div className="kb-hit-card__around">
                    {(aroundMap[key] ?? []).map((c) => (
                      <div key={c.seq} className="kb-hit-card__around-chunk">
                        <span className="kb-chunk-seq">#{c.seq}</span>
                        <span>{c.content}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </StateView>
    </div>
  );
}
