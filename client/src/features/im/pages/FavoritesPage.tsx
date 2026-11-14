/**
 * PIM-08 我的收藏（D03 §3.8，路由 /im/favorites）：
 * - 卡片平铺：消息快照渲染（text 缩略气泡 / 已撤回占位 / 类型化占位）+ 来源会话 + 时间
 * - 顶栏筛选（type：全部/文本/图片/文件/语音/视频/合并转发）
 * - 行操作：取消收藏 / 点击卡片跳原消息锚点（经 pendingLocate → ChatPage 闪烁定位）
 * - 六态：loading 骨架×6 / empty「暂无收藏，右键消息可收藏」+CTA 去消息 / error 重试 /
 *   offline 读缓存（Query 缓存保留） / forbidden 不适用 / degraded 不适用（登记）。
 * 上限 1000 条由服务端校验（3022，14 篇 §7）。
 * D26 antd 换装：页头 Flex+Title、筛选→Segmented、卡片→antd Card+Row/Col 响应式网格、
 * 快照→Typography 段落截断，fav-* 自研类退役。
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Card, Col, Flex, Row, Segmented, Typography, theme } from 'antd';
import { ArrowLeft, Star, StarOff } from 'lucide-react';
import { qk } from '../../../shared/api/keys';
import { formatListTime } from '../../../shared/utils/time';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { useConnectionStore } from '../../../shared/store/connection';
import { unfavoriteMessage } from '../api/im';
import { useFavorites } from '../api/hooks';
import { digestOf, useImStore } from '../store/im';
import type { FavoriteItem } from '../api/im';

/** 顶栏 type 筛选集（D03 §3.8 顶栏筛选；映射服务端 message.type） */
const TYPE_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'file', label: '文件' },
  { value: 'audio_clip', label: '语音' },
  { value: 'video', label: '视频' },
  { value: 'merge_forward', label: '合并转发' },
];

/** 快照渲染：text 缩略（≤4 行截断）/ 已撤回占位（status=2，D03 INT-IM-06）/ 类型化占位 */
function FavoriteBody({ item }: { item: FavoriteItem }) {
  const msg = item.msg;
  const bodyStyle: React.CSSProperties = { marginBottom: 0, fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' };
  if (!msg) {
    return (
      <Typography.Paragraph type="secondary" italic ellipsis={{ rows: 4 }} style={bodyStyle}>
        消息快照不可用
      </Typography.Paragraph>
    );
  }
  if (msg.status === 2) {
    // 撤回消息可收藏：列表渲染占位（快照只存 msg_id+conv_id，详情实时取）
    return (
      <Typography.Paragraph type="secondary" italic ellipsis={{ rows: 4 }} style={bodyStyle}>
        原消息已撤回
      </Typography.Paragraph>
    );
  }
  if (msg.type === 'text' && 'text' in msg.body) {
    return (
      <Typography.Paragraph ellipsis={{ rows: 4 }} style={bodyStyle}>
        {msg.body.text}
      </Typography.Paragraph>
    );
  }
  return (
    <Typography.Paragraph type="secondary" ellipsis={{ rows: 4 }} style={bodyStyle}>
      {digestOf(msg)}
    </Typography.Paragraph>
  );
}

export function FavoritesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { token } = theme.useToken();
  const [type, setType] = useState('all');
  const favQuery = useFavorites(type);
  const connStatus = useConnectionStore((s) => s.status);
  const degradedText = useConnectionStore((s) => s.degradedText);
  const setPendingLocate = useImStore((s) => s.setPendingLocate);
  const applyFavorite = useImStore((s) => s.applyFavorite);
  const [removing, setRemoving] = useState<string | null>(null);

  const items = favQuery.data?.items ?? [];

  const state: ViewState | 'ok' = favQuery.isPending
    ? 'loading'
    : favQuery.isError
      ? 'error'
      : items.length === 0
        ? 'empty'
        : connStatus === 'offline'
          ? 'offline'
          : 'ok';

  /** 取消收藏：本地即时移除 + 失效收藏缓存（幂等，失败靠缓存重拉回真值） */
  const doUnfavorite = (item: FavoriteItem) => {
    if (!item.msg) return;
    const msgId = item.msg.msgId;
    setRemoving(item.id);
    applyFavorite(msgId, false);
    void unfavoriteMessage(msgId)
      .then(() => queryClient.invalidateQueries({ queryKey: qk.im.favorites().slice(0, 2) }))
      .finally(() => setRemoving(null));
  };

  /** 点击卡片：跳原消息锚点（跨页定位经 store 交接，ChatPage 滚动 + 闪烁） */
  const doJump = (item: FavoriteItem) => {
    if (!item.msg || item.msg.status === 2) return; // 撤回占位不可跳
    setPendingLocate({ convId: item.conv.id, seq: item.msg.seq });
    navigate(`/im/c/${item.conv.id}`);
  };

  return (
    <div
      data-testid="fav-page"
      style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: token.colorBgLayout }}
    >
      <Flex
        align="center"
        gap={12}
        wrap="wrap"
        style={{ padding: '12px 16px', borderBottom: `1px solid ${token.colorBorderSecondary}`, background: token.colorBgContainer }}
      >
        <Button variant="text" size="small" icon={<ArrowLeft size={16} />} onClick={() => navigate('/im')} aria-label="返回消息" />
        <Flex align="center" gap={6} style={{ flexShrink: 0 }}>
          <Star size={16} aria-hidden />
          <Typography.Title level={5} style={{ margin: 0 }}>
            我的收藏
          </Typography.Title>
        </Flex>
        <Segmented
          value={type}
          onChange={(v) => setType(v as string)}
          options={TYPE_FILTERS.map((f) => ({
            value: f.value,
            label: (
              <span data-testid={`fav-filter-${f.value}`}>{f.label}</span>
            ),
          }))}
        />
      </Flex>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: 16 }}>
        {state === 'ok' ? (
          <Row gutter={[12, 12]} data-testid="fav-grid">
            {items.map((item) => (
              <Col key={item.id} xs={24} lg={12} xl={8} style={{ minWidth: 0 }}>
                <Card size="small" data-testid="fav-card" styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}>
                  {/* 点击主体：快照 + 来源元信息（跳原消息锚点） */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => doJump(item)}
                    onKeyDown={(e) => e.key === 'Enter' && doJump(item)}
                    title="跳到原消息"
                    style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, cursor: 'pointer', flex: 1, textAlign: 'left' }}
                  >
                    <FavoriteBody item={item} />
                    <Flex gap={8} align="center" style={{ fontSize: 12 }}>
                      <Typography.Text ellipsis style={{ color: token.colorPrimary, fontWeight: 500, fontSize: 12 }}>
                        {item.conv.name || '会话'}
                      </Typography.Text>
                      <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
                        {item.msg?.senderName ?? ''}
                      </Typography.Text>
                    </Flex>
                  </div>
                  <Flex align="center" justify="space-between" style={{ padding: '8px 12px', borderTop: `1px solid ${token.colorBorderSecondary}` }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {formatListTime(item.createdAt)}
                    </Typography.Text>
                    <Button
                      variant="text"
                      size="small"
                      icon={<StarOff size={14} />}
                      data-testid="fav-unfav-btn"
                      disabled={removing === item.id}
                      onClick={() => doUnfavorite(item)}
                      title="取消收藏"
                    >
                      {removing === item.id ? '移除中…' : '取消收藏'}
                    </Button>
                  </Flex>
                </Card>
              </Col>
            ))}
          </Row>
        ) : (
          <StateView
            state={state}
            skeleton={<SkeletonList count={6} />}
            error={favQuery.error}
            onRetry={() => void favQuery.refetch()}
            emptyText="暂无收藏，右键消息可收藏"
            emptyAction={
              <Button onClick={() => navigate('/im')} data-testid="fav-empty-cta">
                去消息
              </Button>
            }
            offlineText="离线中，展示本地缓存的收藏"
            degradedText={degradedText ?? undefined}
          >
            <div />
          </StateView>
        )}
      </div>
    </div>
  );
}
