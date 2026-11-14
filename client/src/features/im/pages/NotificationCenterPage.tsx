/**
 * 全局通知中心（OQ-B07 上移：路由 /notifications——doc/kb/agent 审批复用同一中心；
 * kind 分组随各域通知源接入扩展，PIM-09 D03 §3.9 原始设计）：
 * - 分组 tab：全部 / @我 / 回复我 / 审批 / 公告 / Agent 完成（事件源已接：/notify/agent-tasks）
 * - 列表项：kind 图标 + 标题 + digest + ×N 合并计数（同会话 10s 窗口聚合）+ 时间 + 未读点
 * - 点击路由（D03 §3.9 点击路由表）：mention/reply → 会话定位 seq 闪烁（复用 pendingLocate）；
 *   apply → 会话（审批卡在会话内，PIM-06）；announcement → 全文弹层（简版 Modal）
 * - 「全部已读」+ 分页加载更多（cursor）
 * - 六态：loading 骨架 / empty「暂无通知」/ error 重试 / offline 显示本地已缓存项（新事件停聚）/
 *   forbidden、degraded 不适用（通知列表无 7xxx/降级语义，登记）。
 * D26-O5：公告全文弹层→antd Modal（列表区结构内联化）。
 * D26 收尾：页头→Flex+Title、分组 tab→Segmented（notif-page/notif-tab 自研类退役）。
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Flex, Modal, Segmented, Space, Typography, theme } from 'antd';
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
  { value: 'agent_done', label: 'Agent 完成' }, // 事件源已接：宿主上报 /notify/agent-tasks（14 篇 §3.3 OQ-C32）
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
  const { token } = theme.useToken();
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
    if (item.kind === 'agent_done') {
      // Agent 任务终态（14 篇 §3.3 OQ-C32）：跳工作台 run 面板（conv 关联为 0，非会话派生）
      navigate('/agent');
      return;
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
        break;
    }
  };

  return (
    <div
      data-testid="notif-page"
      style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: token.colorBgLayout }}
    >
      <Flex
        component="header"
        align="center"
        gap={12}
        wrap="wrap"
        style={{ padding: '12px 16px', borderBottom: `1px solid ${token.colorBorderSecondary}`, background: token.colorBgContainer }}
      >
        <Button variant="text" size="small" icon={<ArrowLeft size={16} />} onClick={() => navigate(-1)} aria-label="返回" />
        <Typography.Title level={5} style={{ margin: 0, flexShrink: 0 }}>
          <Space size={6}>
            <Bell size={16} aria-hidden />
            通知中心
          </Space>
        </Typography.Title>
        {/* 分组 tab（D03 §3.9 五分组；Agent 完成事件源已接） */}
        <Segmented
          value={kind}
          onChange={(v) => setKind(v as NotificationKind | 'all')}
          aria-label="通知分组"
          options={KIND_TABS.map((tab) => ({
            value: tab.value,
            disabled: tab.disabled,
            label: <span data-testid={`notif-tab-${tab.value}`}>{tab.label}</span>,
          }))}
        />
        <span style={{ flex: 1 }} />
        <Button
          variant="text"
          data-testid="notif-read-all-btn"
          disabled={markingAll || !(unreadQuery.data ?? 0)}
          onClick={doMarkAll}
        >
          <CheckCheck size={15} />
          {markingAll ? '处理中…' : '全部已读'}
        </Button>
      </Flex>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: 16, maxWidth: 720, width: '100%', margin: '0 auto' }}>
        {state === 'ok' ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column' }} data-testid="notif-list">
              {items.map((item) => {
                const Icon = KIND_ICON[item.kind] ?? Bell;
                const unread = !item.readAt;
                return (
                  <button
                    type="button"
                    key={item.id}
                    data-testid="notif-item"
                    data-kind={item.kind}
                    onClick={() => onItemClick(item)}
                    title="点击查看"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      padding: '10px 12px',
                      cursor: 'pointer',
                      textAlign: 'left',
                      background: 'transparent',
                      border: 'none',
                      borderTop: `1px solid ${token.colorSplit}`,
                    }}
                  >
                    <Icon size={16} aria-hidden color={token.colorPrimary} style={{ flexShrink: 0 }} />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {KIND_LABEL[item.kind] ?? item.kind}
                        </Typography.Text>
                        {item.count > 1 ? (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            ×{item.count}
                          </Typography.Text>
                        ) : null}
                        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
                          {formatListTime(item.createdAt)}
                        </Typography.Text>
                      </span>
                      <span>{item.title}</span>
                      {item.digest ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                          {item.digest}
                        </Typography.Text>
                      ) : null}
                    </span>
                    {unread ? (
                      <span
                        aria-label="未读"
                        style={{ width: 8, height: 8, borderRadius: '50%', background: token.colorError, flexShrink: 0 }}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
            {listQuery.hasNextPage ? (
              <Flex justify="center" style={{ padding: '12px 0' }}>
                <Button
                  variant="secondary"
                  data-testid="notif-load-more"
                  disabled={listQuery.isFetchingNextPage}
                  onClick={() => void listQuery.fetchNextPage()}
                >
                  {listQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
                </Button>
              </Flex>
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
            <div />
          </StateView>
        )}
      </div>

      {/* 公告全文弹层（antd Modal，D03 §3.9 系统公告点击路由） */}
      {annModal ? (
        <Modal
          open
          width={520}
          onCancel={() => setAnnModal(null)}
          destroyOnClose
          footer={null}
          data-testid="ann-modal"
          title={
            <span>
              <Megaphone size={15} aria-hidden /> {annModal.title}
            </span>
          }
          closeIcon={<X size={15} data-testid="ann-modal-close" />}
        >
          <div data-testid="ann-modal-text">{annLoading ? '加载全文…' : annModal.text || '（空公告）'}</div>
        </Modal>
      ) : null}
    </div>
  );
}
