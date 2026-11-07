/**
 * IM Query hooks：key 统一走 shared/api/keys.ts 工厂；
 * WS 推送的精准失效由 ChatPage/App 订阅事件后按 wsInvalidationPrefixes 处理。
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { qk } from '../../../shared/api/keys';
import type { NotificationKind } from '../model/types';
import { fetchConvs, fetchFavorites, fetchMessages, fetchNotifications, fetchUnreadNotificationCount } from './im';

export function useConversations(filter: string = 'all') {
  return useQuery({
    queryKey: qk.im.convs(filter),
    queryFn: () => fetchConvs(filter),
  });
}

export function useConversationMessages(convId: string | null) {
  return useQuery({
    queryKey: qk.im.messages(convId ?? 'none'),
    queryFn: () => fetchMessages(convId as string),
    enabled: !!convId,
  });
}

/** 收藏列表（PIM-08 D03 §3.8：type 过滤；失效走 ['im','favorites'] 前缀） */
export function useFavorites(type: string = 'all') {
  return useQuery({
    queryKey: qk.im.favorites(type),
    queryFn: () => fetchFavorites(type === 'all' ? {} : { type }),
  });
}

/**
 * 通知列表（PIM-09 D03 §3.9：分组 kind tab + cursor 无限翻页；
 * WS notification.new 失效 ['im','notifications'] 前缀后整链重拉）。
 */
export function useNotifications(kind: NotificationKind | 'all' = 'all', unreadOnly: boolean = false) {
  return useInfiniteQuery({
    queryKey: qk.im.notificationList(kind, unreadOnly),
    queryFn: ({ pageParam }) =>
      fetchNotifications({ kind, unreadOnly, cursor: pageParam === '' ? undefined : pageParam, limit: 20 }),
    initialPageParam: '',
    getNextPageParam: (lastPage) => (lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined),
  });
}

/** 通知未读数（PIM-09：铃铛红点，99+ 封顶在组件层；key=['im','notifications','badge'] 打通既有绑定） */
export function useUnreadNotificationCount(enabled: boolean = true) {
  return useQuery({
    queryKey: qk.im.notificationBadge,
    queryFn: fetchUnreadNotificationCount,
    enabled,
  });
}
