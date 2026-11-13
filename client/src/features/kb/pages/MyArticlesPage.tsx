/**
 * 我的文章页（D24）：/kb/my——概览卡数字的落点；两维度分组（公司知识库/我的文章）
 * 列出我写的全部文章（含浏览量）；无编辑操作（写入只留 API 给 AI 拍板）。
 */

import { useNavigate } from 'react-router-dom';
import { Eye } from 'lucide-react';
import { useMyDocs } from '../api/hooks';
import { StateView } from '../../../shared/ui/StateView';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { formatListTime } from '../../../shared/utils/time';
import type { KbDoc } from '../model/types';

export function MyArticlesPage() {
  const navigate = useNavigate();
  const mine = useMyDocs();

  const docs = mine.data?.items ?? [];
  const company = docs.filter((d) => d.space_type !== 'personal');
  const personal = docs.filter((d) => d.space_type === 'personal');

  return (
    <div className="kb-my" data-testid="kb-my">
      <StateView
        state={mine.isPending ? 'loading' : mine.isError ? 'error' : docs.length === 0 ? 'empty' : 'ok'}
        skeleton={<SkeletonList count={6} />}
        error={mine.error}
        onRetry={() => void mine.refetch()}
        emptyText="还没有文章——让 AI 帮你把会话结论沉淀进知识库"
      >
        <Section title="公司知识库" docs={company} badge="company" navigate={navigate} />
        <Section title="我的文章" docs={personal} badge="personal" navigate={navigate} />
      </StateView>
    </div>
  );
}

function Section(props: {
  title: string;
  docs: KbDoc[];
  badge: 'company' | 'personal';
  navigate: (to: string) => void;
}) {
  if (props.docs.length === 0) return null;
  return (
    <section className="kb-my__section">
      <div className="kb-my__section-head">
        <span className={`kb-space-badge kb-space-badge--${props.badge}`}>
          {props.badge === 'company' ? '公司' : '个人'}
        </span>
        {props.title}
        <span className="kb-my__section-count">{props.docs.length} 篇</span>
      </div>
      <div className="kb-my__list">
        {props.docs.map((d) => (
          <button key={d.id} type="button" className="kb-my__item" onClick={() => props.navigate(`/kb/d/${d.id}`)}>
            <span className="kb-my__item-title">{d.title}</span>
            <span className="kb-my__item-meta">
              <Eye size={12} className="kb-board__eye" /> {d.view_count ?? 0} · {formatListTime(d.updated_at)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
