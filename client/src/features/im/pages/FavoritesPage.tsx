/**
 * PIM-08 我的收藏（D03 §3.8，路由 /im/favorites）：
 * - 卡片平铺：消息快照渲染（text 缩略气泡 / 已撤回占位 / 类型化占位）+ 来源会话 + 时间
 * - 顶栏筛选（type：全部/文本/图片/文件/语音/视频/合并转发）
 * - 行操作：取消收藏 / 点击卡片跳原消息锚点（经 pendingLocate → ChatPage 闪烁定位）
 * - 六态：loading 骨架×6 / empty「暂无收藏，右键消息可收藏」+CTA 去消息 / error 重试 /
 *   offline 读缓存（Query 缓存保留） / forbidden 不适用 / degraded 不适用（登记）。
 * 上限 1000 条由服务端校验（3022，14 篇 §7）。
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
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

/** 快照渲染：text 缩略 / 已撤回占位（status=2，D03 INT-IM-06）/ 类型化占位 */
function FavoriteBody({ item }: { item: FavoriteItem }) {
  const msg = item.msg;
  if (!msg) {
    return <div className="fav-card__text fav-card__text--muted">消息快照不可用</div>;
  }
  if (msg.status === 2) {
    // 撤回消息可收藏：列表渲染占位（快照只存 msg_id+conv_id，详情实时取）
    return <div className="fav-card__text fav-card__text--muted">原消息已撤回</div>;
  }
  if (msg.type === 'text' && 'text' in msg.body) {
    return <div className="fav-card__text">{msg.body.text}</div>;
  }
  return <div className="fav-card__text fav-card__text--typed">{digestOf(msg)}</div>;
}

export function FavoritesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
    <div className="fav-page" data-testid="fav-page">
      <header className="fav-page__header">
        <Button variant="text" onClick={() => navigate('/im')} aria-label="返回消息">
          <ArrowLeft size={16} />
        </Button>
        <h1 className="fav-page__title">
          <Star size={16} aria-hidden />
          我的收藏
        </h1>
        <div className="fav-page__filters" role="tablist" aria-label="类型筛选">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={type === f.value}
              className={`fav-filter${type === f.value ? ' fav-filter--active' : ''}`}
              data-testid={`fav-filter-${f.value}`}
              onClick={() => setType(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      <div className="fav-page__body">
        {state === 'ok' ? (
          <div className="fav-grid" data-testid="fav-grid">
            {items.map((item) => (
              <div key={item.id} className="fav-card" data-testid="fav-card">
                <button type="button" className="fav-card__main" onClick={() => doJump(item)} title="跳到原消息">
                  <FavoriteBody item={item} />
                  <div className="fav-card__meta">
                    <span className="fav-card__conv">{item.conv.name || '会话'}</span>
                    <span className="fav-card__sender">{item.msg?.senderName ?? ''}</span>
                  </div>
                </button>
                <div className="fav-card__foot">
                  <span className="fav-card__time">{formatListTime(item.createdAt)}</span>
                  <button
                    type="button"
                    className="fav-card__unfav"
                    data-testid="fav-unfav-btn"
                    disabled={removing === item.id}
                    onClick={() => doUnfavorite(item)}
                    title="取消收藏"
                  >
                    <StarOff size={14} />
                    {removing === item.id ? '移除中…' : '取消收藏'}
                  </button>
                </div>
              </div>
            ))}
          </div>
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
            <div className="fav-grid" />
          </StateView>
        )}
      </div>
    </div>
  );
}
