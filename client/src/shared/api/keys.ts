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
  doc: {
    /** 文档列表 ['doc','files',q,cursor]（D05；写操作后前缀 ['doc','files'] 失效） */
    files: (q: string = '', cursor: string = ''): QueryKeyRO => ['doc', 'files', q, cursor],
    /** 文档详情（含当前正文）['doc','file',id]（保存/恢复/重命名后失效） */
    file: (docId: string): QueryKeyRO => ['doc', 'file', docId],
    /** 版本时间线 ['doc','versions',id]（保存/恢复后失效） */
    versions: (docId: string): QueryKeyRO => ['doc', 'versions', docId],
    /** 回收站 ['doc','trash']（软删/恢复后失效） */
    trash: ['doc', 'trash'] as const,
  },
  kb: {
    /** 空间列表 ['kb','spaces',type]（D07；摄入/重摄入后失效 ['kb','spaces'] 前缀） */
    spaces: (type: string = 'all'): QueryKeyRO => ['kb', 'spaces', type],
    /** 目录懒加载 ['kb','nodes',spaceId,parent] */
    nodes: (spaceId: string, parentId: string = ''): QueryKeyRO => ['kb', 'nodes', spaceId, parentId],
    /** 文档详情 ['kb','doc',docId] */
    doc: (docId: string): QueryKeyRO => ['kb', 'doc', docId],
    /** 分块 ['kb','chunks',docId]（outline/around 派生查询同前缀失效） */
    chunks: (docId: string): QueryKeyRO => ['kb', 'chunks', docId],
    /** jobs 简版 ['kb','jobs',spaceId,status] */
    jobs: (spaceId: string, status: string = 'all'): QueryKeyRO => ['kb', 'jobs', spaceId, status],
  },
  admin: {
    /** 仪表盘 ['admin','dashboard']（60s 轮询刷新；PAD-02） */
    dashboard: ['admin', 'dashboard'] as const,
    /** 用户列表 ['admin','users',keyword,status,cursor]（状态变更后前缀 ['admin','users'] 失效） */
    users: (keyword: string = '', status: number = 0, cursor: string = ''): QueryKeyRO => ['admin', 'users', keyword, status, cursor],
    /** Agent 策略快照 ['admin','policy','agent'] */
    agentPolicy: ['admin', 'policy', 'agent'] as const,
    /** 敏感词列表 ['admin','words',cursor]（增删后前缀 ['admin','words'] 失效） */
    words: (cursor: string = ''): QueryKeyRO => ['admin', 'words', cursor],
    /** 用量汇总 ['admin','usage',days] */
    usage: (days: number = 7): QueryKeyRO => ['admin', 'usage', days],
    /** 审计时间线 ['admin','audit',cursor]（管理写操作后前缀 ['admin','audit'] 失效） */
    audit: (cursor: string = ''): QueryKeyRO => ['admin', 'audit', cursor],
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
