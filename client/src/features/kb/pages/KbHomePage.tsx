/**
 * 知识库首页（D24 博客化）：概览卡+居中大搜索+榜单三列（最新/最热窗口/作者榜）+最近查看。
 * 榜单只收公司知识库文章（公平攀比口径）；「我的文章/公司知识库」入口在左栏（MainLayout 二级导航随 N5）。
 * 最近查看=localStorage 简版（bbw:kb:recent ≤10；SQLite 化随 P1 登记）。
 * D26-O1 补充轮：页面骨架+榜单/概览卡/最近查看全 antd 化（Card+Statistic+List+Tag+Typography，
 * 布局内联 style+theme token——kb-home/kb-board/kb-summary-card 自研样式退役）。
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Flex, Input, List, Segmented, Space, Statistic, Tag, Typography, theme } from 'antd';
import { Flame, ListOrdered, Trophy } from 'lucide-react';
import { useMySummary, useRankings } from '../api/hooks';
import { StateView } from '../../../shared/ui/StateView';
import { SkeletonBlock, SkeletonList } from '../../../shared/ui/Skeleton';
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

/** 榜单行：名次徽标（前三高亮）+标题/元信息两行（onClick 缺省=纯展示，作者榜行） */
function BoardRow(props: { rank: number; title: string; meta: React.ReactNode; onClick?: () => void }) {
  const { token } = theme.useToken();
  const top = props.rank < 3;
  return (
    <List.Item
      style={{
        padding: '6px 6px',
        borderRadius: 8,
        cursor: props.onClick ? 'pointer' : undefined,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
      }}
      onClick={props.onClick}
    >
      <span
        style={{
          flex: 'none',
          width: 20,
          height: 20,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          fontWeight: 600,
          background: top ? token.colorPrimaryBg : token.colorFillSecondary,
          color: top ? token.colorPrimary : token.colorTextSecondary,
        }}
      >
        {props.rank}
      </span>
      <Flex vertical gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Typography.Text ellipsis style={{ fontSize: 13 }}>
          {props.title}
        </Typography.Text>
        <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
          {props.meta}
        </Typography.Text>
      </Flex>
    </List.Item>
  );
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
    <div
      data-testid="kb-home"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflowY: 'auto', padding: '20px 28px 32px', gap: 20 }}
    >
      {/* B1 概览卡 */}
      <section>
        <StateView
          state={summary.isPending ? 'loading' : summary.isError ? 'error' : summary.data ? 'ok' : 'empty'}
          skeleton={<SkeletonBlock height={92} />}
          error={summary.error}
          onRetry={() => void summary.refetch()}
        >
          {summary.data ? (
            <Card size="small" data-testid="kb-summary-card" style={{ borderRadius: 10 }}>
              <Flex gap={40} wrap="wrap">
                <Statistic
                  title={<span style={{ fontSize: 12 }}>我的文章{summary.data.month_new > 0 ? `（本月 +${summary.data.month_new}）` : ''}</span>}
                  value={summary.data.doc_count}
                />
                <Statistic title={<span style={{ fontSize: 12 }}>总浏览量</span>} value={fmtNum(summary.data.total_views)} />
                <Statistic
                  title={<span style={{ fontSize: 12 }}>7 日新增浏览</span>}
                  value={`▲${fmtNum(summary.data.views_7d)}`}
                  valueStyle={{ color: 'var(--bbw-success)' }}
                />
                <Statistic
                  title={<span style={{ fontSize: 12 }}>全公司作者榜</span>}
                  value={summary.data.author_rank > 0 ? `#${summary.data.author_rank}` : '未上榜'}
                />
              </Flex>
              <Flex justify="space-between" align="center" gap={12} wrap="wrap" style={{ borderTop: '1px solid var(--bbw-gray-3)', paddingTop: 8 }}>
                {summary.data.last_doc ? (
                  <Typography.Link onClick={() => navigate(`/kb/d/${summary.data!.last_doc!.id}`)}>
                    最近发表：《{summary.data.last_doc.title}》 {formatListTime(summary.data.last_doc.created_at)}
                  </Typography.Link>
                ) : (
                  <Typography.Text type="secondary">还没有文章——让 AI 帮你把会话结论沉淀进知识库</Typography.Text>
                )}
                <Typography.Link onClick={() => navigate('/kb/my')}>查看我的文章 →</Typography.Link>
              </Flex>
            </Card>
          ) : null}
        </StateView>
      </section>

      {/* B2 大搜索（D26-O1 换装 antd Input.Search） */}
      <section style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 4px' }}>
        <Input.Search
          size="large"
          data-testid="kb-bigsearch"
          placeholder="搜索公司知识：例如「登录 token 过期怎么处理」"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onSearch={submit}
          enterButton="搜索"
          autoFocus
        />
      </section>

      {/* B3 榜单三列 */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 }}>
        <Card
          size="small"
          data-testid="kb-board-latest"
          style={{ borderRadius: 10, minHeight: 200 }}
          title={
            <Space size={6}>
              <ListOrdered size={15} /> 最新文章 Top10
            </Space>
          }
        >
          <StateView
            state={latest.isPending ? 'loading' : latest.isError ? 'error' : (latest.data?.docs?.length ?? 0) === 0 ? 'empty' : 'ok'}
            skeleton={<SkeletonList count={4} />}
            error={latest.error}
            onRetry={() => void latest.refetch()}
            emptyText="虚位以待——第一篇就是你的"
          >
            <List
              dataSource={latest.data?.docs ?? []}
              rowKey="doc_id"
              split={false}
              renderItem={(d, i) => (
                <BoardRow
                  rank={i + 1}
                  title={d.title}
                  meta={`${d.user_name || '匿名'} · ${d.node_name ? `${d.node_name}/` : ''} ${formatListTime(d.created_at)}`}
                  onClick={() => navigate(`/kb/d/${d.doc_id}`)}
                />
              )}
            />
          </StateView>
        </Card>

        <Card
          size="small"
          data-testid="kb-board-hot"
          style={{ borderRadius: 10, minHeight: 200 }}
          title={
            <Space size={6}>
              <Flame size={15} /> 最热文章 Top10
            </Space>
          }
          extra={
            <Segmented
              size="small"
              value={hotWindow}
              onChange={(v) => setHotWindow(v as '7d' | '30d' | 'all')}
              options={[
                { value: '7d', label: '7 天' },
                { value: '30d', label: '30 天' },
                { value: 'all', label: '总榜' },
              ]}
            />
          }
        >
          <StateView
            state={hot.isPending ? 'loading' : hot.isError ? 'error' : (hot.data?.docs?.length ?? 0) === 0 ? 'empty' : 'ok'}
            skeleton={<SkeletonList count={4} />}
            error={hot.error}
            onRetry={() => void hot.refetch()}
            emptyText="窗口内暂无浏览——发文就有机会上榜"
          >
            <List
              dataSource={hot.data?.docs ?? []}
              rowKey="doc_id"
              split={false}
              renderItem={(d, i) => (
                <BoardRow
                  rank={i + 1}
                  title={d.title}
                  meta={`${d.user_name || '匿名'} · ${fmtNum(d.hot)} 次浏览`}
                  onClick={() => navigate(`/kb/d/${d.doc_id}`)}
                />
              )}
            />
          </StateView>
        </Card>

        <Card
          size="small"
          data-testid="kb-board-authors"
          style={{ borderRadius: 10, minHeight: 200 }}
          title={
            <Space size={6}>
              <Trophy size={15} /> 作者榜 Top10
            </Space>
          }
        >
          <StateView
            state={authors.isPending ? 'loading' : authors.isError ? 'error' : (authors.data?.authors?.length ?? 0) === 0 ? 'empty' : 'ok'}
            skeleton={<SkeletonList count={4} />}
            error={authors.error}
            onRetry={() => void authors.refetch()}
            emptyText="虚位以待"
          >
            <List
              dataSource={authors.data?.authors ?? []}
              rowKey="user_id"
              split={false}
              renderItem={(a) => (
                <BoardRow
                  rank={a.rank}
                  title={a.user_name || `用户 ${a.user_id}`}
                  meta={`${a.doc_count} 篇 · ${fmtNum(a.total_views)} 次浏览`}
                />
              )}
            />
          </StateView>
        </Card>
      </section>

      {/* B4 最近查看 */}
      {recent.length > 0 ? (
        <section>
          <Typography.Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
            最近查看
          </Typography.Text>
          <Flex wrap="wrap" gap={8}>
            {recent.map((r) => (
              <Tag
                key={r.docId}
                style={{ cursor: 'pointer', padding: '4px 12px', borderRadius: 14, fontSize: 12 }}
                onClick={() => navigate(`/kb/d/${r.docId}`)}
              >
                《{r.title}》 {formatListTime(r.at)}
              </Tag>
            ))}
          </Flex>
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
