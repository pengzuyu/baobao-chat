/**
 * 文章内容面板（D24 真机修正轮 2026-11-13）：KbShell tab 容器内渲染——
 * 标题/维度徽章/作者/创建·更新时间/浏览量 + 大纲锚条 + markdown 全文；
 * 打开即 view 上报（作者本人服务端短路；日去重幂等）。由 pages/ArticlePage 抽组件化。
 * D26-O1 补充轮：外围排版 antd 化——标题 Typography.Title、元信息 Space+Tag+Text、
 * 大纲锚条 antd Button（kb-article 族自研类退役改内联+token）。
 * 正文 chunk 内 MarkdownText（agent-md 渲染层）保留不动。
 */

import { useEffect } from 'react';
import { Eye } from 'lucide-react';
import { Button as AntdButton, Flex, Space, Tag, Typography, theme } from 'antd';
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
  const { token } = theme.useToken();
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
    <div data-testid="kb-article" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <StateView
        state={state}
        skeleton={
          <div style={{ padding: '20px 40px', display: 'flex', flexDirection: 'column', gap: 12 }}>
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
          <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
            <aside
              style={{
                flex: 'none',
                width: 200,
                overflowY: 'auto',
                borderRight: `1px solid ${token.colorBorderSecondary}`,
                padding: '16px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <Typography.Text type="secondary" style={{ fontSize: 12, marginBottom: 6 }}>
                大纲
              </Typography.Text>
              {(outline.data ?? []).length > 0 ? (
                (outline.data ?? []).map((o) => (
                  <AntdButton
                    key={`${o.heading_path}-${o.seq}`}
                    type="text"
                    size="small"
                    block
                    style={{ textAlign: 'left', padding: '4px 8px', height: 'auto' }}
                    onClick={() =>
                      document.querySelector(`[data-chunk-seq="${o.seq}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }
                  >
                    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.heading_path}</span>
                  </AntdButton>
                ))
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  （无大纲）
                </Typography.Text>
              )}
            </aside>
            <article style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '20px 40px 48px', maxWidth: 860, margin: '0 auto' }}>
              <Flex vertical gap={8} style={{ marginBottom: 16 }}>
                <Typography.Title level={3} style={{ margin: 0, fontSize: 24 }}>
                  {doc.data.title}
                </Typography.Title>
                <Space size={14} wrap align="center">
                  {doc.data.space_type === 'personal' ? (
                    <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                      我的文章
                    </Tag>
                  ) : (
                    <Tag style={{ marginInlineEnd: 0 }}>公司知识库</Tag>
                  )}
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    作者 {doc.data.created_by}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    创建 {formatListTime(doc.data.created_at)}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    更新 {formatListTime(doc.data.updated_at)}
                  </Typography.Text>
                  <Space size={4}>
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                      <Eye size={13} style={{ verticalAlign: -2 }} /> {fmtViews(view.data?.view_count ?? doc.data.view_count ?? 0)}
                    </Typography.Text>
                  </Space>
                </Space>
              </Flex>
              {chunks.data && chunks.data.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {chunks.data.map((c) => (
                    <div key={c.seq} data-chunk-seq={c.seq}>
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
