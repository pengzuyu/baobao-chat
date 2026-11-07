/**
 * TanStack Query key 工厂（集中维护，D01 §12.2 规则 4）
 * 以及 WS 推送 → Query 精准失效映射表。
 */

export type QueryKeyRO = readonly unknown[];

export const qk = {
  im: {
    /** 会话列表 ['im','convs',filter] */
    convs: (filter: string = 'all'): QueryKeyRO => ['im', 'convs', filter],
    /** 会话详情 ['im','conv',id] */
    conv: (convId: string): QueryKeyRO => ['im', 'conv', convId],
    /** 消息流 ['im','messages',convId,cursor] */
    messages: (convId: string, cursor?: string | null): QueryKeyRO => ['im', 'messages', convId, cursor ?? null],
    /** 收藏列表 ['im','favorites',type]（PIM-08；前缀失效走 ['im','favorites']） */
    favorites: (type: string = 'all'): QueryKeyRO => ['im', 'favorites', type],
    /** 通知列表 ['im','notifications','list',kind,unreadOnly]（PIM-09；前缀失效走 ['im','notifications','list']） */
    notificationList: (kind: string = 'all', unreadOnly: boolean = false): QueryKeyRO => [
      'im',
      'notifications',
      'list',
      kind,
      unreadOnly,
    ],
    /** 通知未读数（铃铛红点）['im','notifications','badge']（PIM-09；WS notification.new 触发失效） */
    notificationBadge: ['im', 'notifications', 'badge'] as const,
  },
  auth: {
    session: ['auth', 'session'] as const,
  },
} as const;

/**
 * WS 推送 → 精准失效映射（14 篇 §3.2 事件目录 → Query key 前缀）。
 * features 层订阅事件后按此表 invalidate，禁止整库 invalidateAll。
 */
export const wsInvalidationPrefixes: Record<string, QueryKeyRO[]> = {
  'msg.new': [['im', 'convs']],
  'msg.recall': [['im', 'messages']],
  'msg.updated': [['im', 'messages']],
  'msg.receipt': [], // 回执走轻量通道更新 store，不触发列表重排（D03 §7）
  'conv.updated': [['im', 'convs']],
  'badge.updated': [], // 未读由 store 内联更新
  'presence.changed': [], // 在线点走 store
  'notification.new': [['im', 'notifications']], // 通知中心（PIM-09）：列表 + 铃铛红点失效重拉
};
