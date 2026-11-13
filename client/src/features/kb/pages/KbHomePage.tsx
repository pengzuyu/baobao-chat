/**
 * 知识库首页（D24 博客化）：概览卡+居中大搜索+榜单三列（最新/最热窗口/作者榜）+最近查看。
 * 榜单只收公司知识库文章（公平攀比口径）；「我的文章/公司知识库」入口在左栏（MainLayout 二级导航随 N5）。
 * 最近查看=localStorage 简版（bbw:kb:recent ≤10；SQLite 化随 P1 登记）。
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, Flame, ListOrdered, Search, Trophy } from 'lucide-react';
import { useMySummary, useRankings } from '../api/hooks';
import { StateView } from '../../../shared/ui/StateView';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { formatListTime } from '../../../shared/utils/time';

const RECENT_KEY = 'bbw:kb:recent';

interface RecentItem {
  docId: string;
  title: string;
  at: number;
}

export function readKbRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as RecentItem[];
    return Array.isArray(arr) ? arr.slice(0, 10) : [];
  } catch {
    return [];
  }
}

export function pushKbRecent(docId: string, title: string): void {
  const next = [{ docId, title, at: Date.now() }, ...readKbRecent().filter((r) => r.docId !== docId)].slice(0, 10);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式等写失败静默 */
  }
}

export function KbHomePage() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [hotWindow, setHotWindow] = useState<'7d' | '30d' | 'all'>('7d');

  const summary = useMySummary();
  const latest = useRankings('latest');
  const hot = useRankings('hot', hotWindow);
  const authors = useRankings('authors');
  const recent = useMemo(readKbRecent, []);

  const submit = () => {
    const kw = q.trim();
    if (kw) navigate(`/kb/search?q=${encodeURIComponent(kw)}`);
  };

  return (
    <div className="kb-home" data-testid="kb-home">
      {/* B1 概览卡 */}
      <section className="kb-home__summary">
        <StateView
          state={summary.isPending ? 'loading' : summary.isError ? 'error' : summary.data ? 'ok' : 'empty'}
          skeleton={<div className="kb-home__summary-skeleton" />}
          error={summary.error}
          onRetry={() => void summary.refetch()}
        >
          {summary.data ? (
            <div className="kb-summary-card" data-testid="kb-summary-card">
              <div className="kb-summary-card__stats">
                <div className="kb-summary-card__stat">
                  <span className="kb-summary-card__num">{summary.data.doc_count}</span>
                  <span className="kb-summary-card__label">我的文章{summary.data.month_new > 0 ? `（本月 +${summary.data.month_new}）` : ''}</span>
                </div>
                <div className="kb-summary-card__stat">
                  <span className="kb-summary-card__num">{fmtNum(summary.data.total_views)}</span>
                  <span className="kb-summary-card__label">总浏览量</span>
                </div>
                <div className="kb-summary-card__stat">
                  <span className="kb-summary-card__num kb-summary-card__num--up">▲{fmtNum(summary.data.views_7d)}</span>
                  <span className="kb-summary-card__label">7 日新增浏览</span>
                </div>
                <div className="kb-summary-card__stat">
                  <span className="kb-summary-card__num">
                    {summary.data.author_rank > 0 ? `#${summary.data.author_rank}` : '未上榜'}
                  </span>
                  <span className="kb-summary-card__label">全公司作者榜</span>
                </div>
              </div>
              <div className="kb-summary-card__foot">
                {summary.data.last_doc ? (
                  <button type="button" className="kb-link-btn" onClick={() => navigate(`/kb/d/${summary.data!.last_doc!.id}`)}>
                    最近发表：《{summary.data.last_doc.title}》 {formatListTime(summary.data.last_doc.created_at)}
                  </button>
                ) : (
                  <span className="kb-summary-card__hint">还没有文章——让 AI 帮你把会话结论沉淀进知识库</span>
                )}
                <button type="button" className="kb-link-btn" onClick={() => navigate('/kb/my')}>
                  查看我的文章 →
                </button>
              </div>
            </div>
          ) : null}
        </StateView>
      </section>

      {/* B2 大搜索 */}
      <section className="kb-home__search">
        <div className="kb-bigsearch" data-testid="kb-bigsearch">
          <Search size={20} className="kb-bigsearch__icon" />
          <input
            className="kb-bigsearch__input"
            placeholder="搜索公司知识：例如「登录 token 过期怎么处理」"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            autoFocus
          />
          <button type="button" className="kb-bigsearch__btn" onClick={submit} disabled={!q.trim()}>
            搜索
          </button>
        </div>
      </section>

      {/* B3 榜单三列 */}
      <section className="kb-home__boards">
        <div className="kb-board" data-testid="kb-board-latest">
          <div className="kb-board__head">
            <ListOrdered size={15} /> 最新文章 Top10
          </div>
          <StateView
            state={latest.isPending ? 'loading' : latest.isError ? 'error' : (latest.data?.docs?.length ?? 0) === 0 ? 'empty' : 'ok'}
            skeleton={<SkeletonList count={4} />}
            error={latest.error}
            onRetry={() => void latest.refetch()}
            emptyText="虚位以待——第一篇就是你的"
          >
            <ol className="kb-board__list">
              {(latest.data?.docs ?? []).map((d, i) => (
                <li key={d.doc_id} className="kb-board__item" onClick={() => navigate(`/kb/d/${d.doc_id}`)}>
                  <span className={`kb-board__rank${i < 3 ? ' kb-board__rank--top' : ''}`}>{i + 1}</span>
                  <div className="kb-board__body">
                    <span className="kb-board__title">{d.title}</span>
                    <span className="kb-board__meta">
                      {d.user_name || '匿名'} · {d.node_name ? `${d.node_name}/` : ''} {formatListTime(d.created_at)}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </StateView>
        </div>

        <div className="kb-board" data-testid="kb-board-hot">
          <div className="kb-board__head">
            <Flame size={15} /> 最热文章 Top10
            <span className="kb-board__tabs">
              {(['7d', '30d', 'all'] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  className={`kb-board__tab${hotWindow === w ? ' kb-board__tab--on' : ''}`}
                  onClick={() => setHotWindow(w)}
                >
                  {w === '7d' ? '7 天' : w === '30d' ? '30 天' : '总榜'}
                </button>
              ))}
            </span>
          </div>
          <StateView
            state={hot.isPending ? 'loading' : hot.isError ? 'error' : (hot.data?.docs?.length ?? 0) === 0 ? 'empty' : 'ok'}
            skeleton={<SkeletonList count={4} />}
            error={hot.error}
            onRetry={() => void hot.refetch()}
            emptyText="窗口内暂无浏览——发文就有机会上榜"
          >
            <ol className="kb-board__list">
              {(hot.data?.docs ?? []).map((d, i) => (
                <li key={d.doc_id} className="kb-board__item" onClick={() => navigate(`/kb/d/${d.doc_id}`)}>
                  <span className={`kb-board__rank${i < 3 ? ' kb-board__rank--top' : ''}`}>{i + 1}</span>
                  <div className="kb-board__body">
                    <span className="kb-board__title">{d.title}</span>
                    <span className="kb-board__meta">
                      {d.user_name || '匿名'} · <Eye size={11} className="kb-board__eye" /> {fmtNum(d.hot)}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </StateView>
        </div>

        <div className="kb-board" data-testid="kb-board-authors">
          <div className="kb-board__head">
            <Trophy size={15} /> 作者榜 Top10
          </div>
          <StateView
            state={authors.isPending ? 'loading' : authors.isError ? 'error' : (authors.data?.authors?.length ?? 0) === 0 ? 'empty' : 'ok'}
            skeleton={<SkeletonList count={4} />}
            error={authors.error}
            onRetry={() => void authors.refetch()}
            emptyText="虚位以待"
          >
            <ol className="kb-board__list">
              {(authors.data?.authors ?? []).map((a) => (
                <li key={a.user_id} className="kb-board__item kb-board__item--author">
                  <span className={`kb-board__rank${a.rank < 3 ? ' kb-board__rank--top' : ''}`}>{a.rank}</span>
                  <div className="kb-board__body">
                    <span className="kb-board__title">{a.user_name || `用户 ${a.user_id}`}</span>
                    <span className="kb-board__meta">
                      {a.doc_count} 篇 · <Eye size={11} className="kb-board__eye" /> {fmtNum(a.total_views)}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </StateView>
        </div>
      </section>

      {/* B4 最近查看 */}
      {recent.length > 0 ? (
        <section className="kb-home__recent">
          <div className="kb-home__recent-head">最近查看</div>
          <div className="kb-home__recent-list">
            {recent.map((r) => (
              <button key={r.docId} type="button" className="kb-home__recent-item" onClick={() => navigate(`/kb/d/${r.docId}`)}>
                《{r.title}》 {formatListTime(r.at)}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function fmtNum(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
