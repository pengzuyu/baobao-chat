/**
 * 检索结果页（D24）：/kb/search?q=——现 KbPage 内 SearchPanel 吸收为独立页面；
 * 命中卡文章化（标题+维度徽章+snippet 高亮+浏览量），点击跳阅读页锚点；
 * 展开上下文（seq 前后块）沿用；degraded 黄条（vector/reranker）与合规提示保留。
 * D26-O1 补充轮：命中卡→antd Card+List、维度徽章→Tag、降级/合规条→Alert、
 * 展开上下文块 Typography 化（kb-search-page/kb-hit-card 族自研样式退役）。
 */

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Card, Flex, Input, List, Space, Tag, Typography, theme } from 'antd';
import { useMutation } from '@tanstack/react-query';
import { fetchChunksAround, queryKb } from '../api/kb';
import type { KbChunk, KbQueryHit } from '../model/types';
import { HighlightText } from '../components/HighlightText';
import { StateView } from '../../../shared/ui/StateView';
import { SkeletonList } from '../../../shared/ui/Skeleton';

export function SearchPage() {
  const { token } = theme.useToken();
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
    <div
      data-testid="kb-search-page"
      style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: '16px 28px 32px', display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div style={{ maxWidth: 640, marginBottom: 12 }}>
        <Input.Search
          value={input}
          placeholder="搜索公司知识"
          onChange={(e) => setInput(e.target.value)}
          onSearch={submit}
          enterButton="搜索"
          autoFocus
        />
      </div>

      {state === 'ok' ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          命中 {items.length} · {search.data?.took_ms ?? 0}ms
        </Typography.Text>
      ) : null}
      {degraded.includes('vector') ? (
        <Alert type="warning" showIcon message="语义检索暂不可用，已切换关键词模式" />
      ) : null}
      {degraded.includes('reranker') ? (
        <Alert type="warning" showIcon message="重排服务暂不可用，已按融合序展示" />
      ) : null}
      {search.data?.filtered_hint ? (
        <Alert type="warning" showIcon message={`${search.data.filtered_hint}（结果可能不完整）`} />
      ) : null}

      <StateView
        state={state}
        skeleton={<SkeletonList count={3} />}
        error={search.error}
        onRetry={() => keyword && search.mutate(keyword)}
        emptyText={keyword ? '未找到相关内容：尝试更换关键词' : '输入关键词开始搜索'}
      >
        <List
          dataSource={items}
          rowKey={(hit) => `${hit.doc_id}#${hit.chunk_seq}`}
          split={false}
          renderItem={(hit) => {
            const key = `${hit.doc_id}#${hit.chunk_seq}`;
            return (
              <List.Item style={{ padding: 0 }}>
                <Card size="small" data-testid="kb-hit-card" style={{ width: '100%', marginBottom: 10, borderRadius: 8 }}>
                  <Flex align="center" gap={8} style={{ minWidth: 0, marginBottom: 6 }}>
                    <Tag style={{ marginInlineEnd: 0 }}>{hit.space_type === 'company' ? '公司' : '个人'}</Tag>
                    <Typography.Text ellipsis style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>
                      <Typography.Link onClick={() => navigate(`/kb/d/${hit.doc_id}`)}>
                        {hit.title}
                        {hit.heading_path ? ` · ${hit.heading_path}` : ''}
                      </Typography.Link>
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 11, flex: 'none' }}>
                      {hit.rerank_score ? hit.rerank_score.toFixed(2) : hit.score.toFixed(4)}
                    </Typography.Text>
                  </Flex>
                  <div style={{ fontSize: 13, lineHeight: 1.7, wordBreak: 'break-all' }}>
                    <HighlightText text={hit.snippet} ranges={hit.highlight} />
                  </div>
                  <Space size={16} style={{ marginTop: 6 }}>
                    <Typography.Link style={{ fontSize: 12 }} onClick={() => void toggleExpand(hit)}>
                      展开上下文
                    </Typography.Link>
                    <Typography.Link style={{ fontSize: 12 }} onClick={() => navigate(`/kb/d/${hit.doc_id}`)}>
                      阅读全文
                    </Typography.Link>
                  </Space>
                  {expanded[key] ? (
                    <Flex vertical gap={6} style={{ marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${token.colorBorder}` }}>
                      {(aroundMap[key] ?? []).map((c) => (
                        <Flex key={c.seq} gap={8} style={{ minWidth: 0 }}>
                          <Typography.Text type="secondary" code style={{ fontSize: 11, flex: 'none' }}>
                            #{c.seq}
                          </Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 12, minWidth: 0 }}>
                            {c.content}
                          </Typography.Text>
                        </Flex>
                      ))}
                    </Flex>
                  ) : null}
                </Card>
              </List.Item>
            );
          }}
        />
      </StateView>
    </div>
  );
}
