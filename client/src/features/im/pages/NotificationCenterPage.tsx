/**
 * PIM-09 通知中心（D03 §3.9，路由 /im/notifications）：
 * - 分组 tab：全部 / @我 / 回复我 / 审批 / 公告 / Agent 完成（预留置灰——服务端无 agent 域事件源，登记）
 * - 列表项：kind 图标 + 标题 + digest + ×N 合并计数（同会话 10s 窗口聚合）+ 时间 + 未读点
 * - 点击路由（D03 §3.9 点击路由表）：mention/reply → 会话定位 seq 闪烁（复用 pendingLocate）；
 *   apply → 会话（审批卡在会话内，PIM-06）；announcement → 全文弹层（简版 Modal）
 * - 「全部已读」+ 分页加载更多（cursor）
 * - 六态：loading 骨架 / empty「暂无通知」/ error 重试 / offline 显示本地已缓存项（新事件停聚）/
 *   forbidden、degraded 不适用（通知列表无 7xxx/降级语义，登记）。
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, AtSign, BadgeCheck, Bell, Bot, CheckCheck, Megaphone, Reply, X } from 'lucide-react';
import { formatListTime } from '../../../shared/utils/time';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { useConnectionStore } from '../../../shared/store/connection';
import type { NotificationItem, NotificationKind } from '../model/types';
import { fetchConvDetail, markNotificationsRead } from '../api/im';
import { useNotifications, useUnreadNotificationCount } from '../api/hooks';
import { useImStore } from '../store/im';

/** 分组 tab（D03 §3.9 五分组；Agent 完成预留禁用） */
const KIND_TABS: Array<{ value: NotificationKind | 'all'; label: string; disabled?: boolean }> = [
  { value: 'all', label: '全部' },
  { value: 'mention', label: '@我' },
  { value: 'reply', label: '回复我' },
  { value: 'apply', label: '审批' },
  { value: 'announcement', label: '公告' },
  { value: 'agent_done', label: 'Agent 完成', disabled: true }, // 预留：agent 域事件源未接，登记
];

const KIND_ICON: Record<NotificationKind, typeof AtSign> = {
  mention: AtSign,
  reply: Reply,
  apply: BadgeCheck,
  agent_done: Bot,
  announcement: Megaphone,
};

const KIND_LABEL: Record<NotificationKind, string> = {
  mention: '@我',
  reply: '回复我',
  apply: '审批',
  agent_done: 'Agent 完成',
  announcement: '公告',
};

export function NotificationCenterPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<NotificationKind | 'all'>('all');
  const [markingAll, setMarkingAll] = useState(false);
  /** 公告全文弹层（简版 Modal：标题 + 全文 + 关闭） */
  const [annModal, setAnnModal] = useState<{ title: string; text: string } | null>(null);
  /** 公告全文拉取中（弹层内 loading 态） */
  const [annLoading, setAnnLoading] = useState(false);

  const connStatus = useConnectionStore((s) => s.status);
  const degradedText = useConnectionStore((s) => s.degradedText);
  const setPendingLocate = useImStore((s) => s.setPendingLocate);

  const listQuery = useNotifications(kind, false);
  const unreadQuery = useUnreadNotificationCount();
  const items = useMemo(() => listQuery.data?.pages.flatMap((p) => p.items) ?? [], [listQuery.data]);

  const state: ViewState | 'ok' = listQuery.isPending
    ? 'loading'
    : listQuery.isError
      ? 'error'
      : items.length === 0
        ? 'empty'
        : connStatus === 'offline'
          ? 'offline'
          : 'ok';

  /** 前缀失效通知域全部缓存（列表各分组 + 红点） */
  const invalidateNotifications = () => {
    void queryClient.invalidateQueries({ queryKey: ['im', 'notifications'] });
  };

  /** 全部已读：POST all → 失效重拉（红点清零） */
  const doMarkAll = () => {
    setMarkingAll(true);
    void markNotificationsRead({ all: true })
      .then(invalidateNotifications)
      .finally(() => setMarkingAll(false));
  };

  /** 点击路由（D03 §3.9 点击路由表）：mention/reply→定位闪烁；apply→会话；announcement→全文弹层 */
  const onItemClick = (item: NotificationItem) => {
    if (!item.readAt) {
      // 未读项点击即读（单条；失败不阻断路由）
      void markNotificationsRead({ ids: [item.id] }).then(invalidateNotifications);
    }
    if (!item.convId) return;
    switch (item.kind) {
      case 'mention':
      case 'reply':
        if (item.seq && item.seq > 0) setPendingLocate({ convId: item.convId, seq: item.seq });
        navigate(`/im/c/${item.convId}`);
        break;
      case 'apply':
        // 审批卡渲染在会话流内（PIM-06）：跳会话不强制定位
        navigate(`/im/c/${item.convId}`);
        break;
      case 'announcement': {
        // 全文弹层（简版）：优先实时取 group_setting.announcement，失败回落 digest
        setAnnLoading(true);
        setAnnModal({ title: item.title, text: item.digest ?? '' });
        void fetchConvDetail(item.convId)
          .then((d) => {
            const full = d.groupSetting?.announcement;
            if (full) setAnnModal({ title: d.name ? `「${d.name}」公告` : item.title, text: full });
          })
          .catch(() => undefined)
          .finally(() => setAnnLoading(false));
        break;
      }
      default:
        break; // agent_done 预留
    }
  };

  return (
    <div className="notif-page" data-testid="notif-page">
      <header className="notif-page__header">
        <Button variant="text" onClick={() => navigate('/im')} aria-label="返回消息">
          <ArrowLeft size={16} />
        </Button>
        <h1 className="notif-page__title">
          <Bell size={16} aria-hidden />
          通知中心
        </h1>
        <div className="notif-page__tabs" role="tablist" aria-label="通知分组">
          {KIND_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={kind === tab.value}
              className={`notif-tab${kind === tab.value ? ' notif-tab--active' : ''}`}
              data-testid={`notif-tab-${tab.value}`}
              disabled={tab.disabled}
              title={tab.disabled ? 'Agent 完成通知待 D08 接入（预留）' : undefined}
              onClick={() => setKind(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <Button
          variant="text"
          data-testid="notif-read-all-btn"
          disabled={markingAll || !(unreadQuery.data ?? 0)}
          onClick={doMarkAll}
        >
          <CheckCheck size={15} />
          {markingAll ? '处理中…' : '全部已读'}
        </Button>
      </header>

      <div className="notif-page__body">
        {state === 'ok' ? (
          <>
            <div className="notif-list" data-testid="notif-list">
              {items.map((item) => {
                const Icon = KIND_ICON[item.kind] ?? Bell;
                const unread = !item.readAt;
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`notif-item${unread ? ' notif-item--unread' : ''}`}
                    data-testid="notif-item"
                    data-kind={item.kind}
                    onClick={() => onItemClick(item)}
                    title="点击查看"
                  >
                    <span className={`notif-item__icon notif-item__icon--${item.kind}`}>
                      <Icon size={16} aria-hidden />
                    </span>
                    <span className="notif-item__main">
                      <span className="notif-item__row">
                        <span className="notif-item__kind">{KIND_LABEL[item.kind] ?? item.kind}</span>
                        {item.count > 1 ? <span className="notif-item__count">×{item.count}</span> : null}
                        <span className="notif-item__time">{formatListTime(item.createdAt)}</span>
                      </span>
                      <span className="notif-item__title">{item.title}</span>
                      {item.digest ? <span className="notif-item__digest">{item.digest}</span> : null}
                    </span>
                    {unread ? <span className="notif-item__dot" aria-label="未读" /> : null}
                  </button>
                );
              })}
            </div>
            {listQuery.hasNextPage ? (
              <div className="notif-page__more">
                <Button
                  variant="secondary"
                  data-testid="notif-load-more"
                  disabled={listQuery.isFetchingNextPage}
                  onClick={() => void listQuery.fetchNextPage()}
                >
                  {listQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <StateView
            state={state}
            skeleton={<SkeletonList count={6} />}
            error={listQuery.error}
            onRetry={() => void listQuery.refetch()}
            emptyText="暂无通知"
            offlineText="离线中，展示本地已缓存的通知（新事件暂停聚合）"
            degradedText={degradedText ?? undefined}
          >
            <div className="notif-list" />
          </StateView>
        )}
      </div>

      {/* 公告全文弹层（简版 Modal，D03 §3.9 系统公告点击路由） */}
      {annModal ? (
        <div className="notif-modal-mask" data-testid="ann-modal" onClick={() => setAnnModal(null)}>
          <div className="notif-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="公告全文">
            <header className="notif-modal__header">
              <span className="notif-modal__title">
                <Megaphone size={15} aria-hidden />
                {annModal.title}
              </span>
              <button type="button" className="icon-btn" onClick={() => setAnnModal(null)} aria-label="关闭" data-testid="ann-modal-close">
                <X size={15} />
              </button>
            </header>
            <div className="notif-modal__body" data-testid="ann-modal-text">
              {annLoading ? '加载全文…' : annModal.text || '（空公告）'}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
