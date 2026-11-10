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
  mail: {
    /** 邮箱摘要（懒开户触发点） ['mail','summary'] */
    summary: ['mail', 'summary'] as const,
    /** 文件夹消息列表 ['mail','messages',folder,filter,cursor]（前缀失效走 ['mail','messages']） */
    messages: (folder: string, filter: string = '', cursor: string | null = null): QueryKeyRO => [
      'mail', 'messages', folder, filter, cursor ?? null,
    ],
    /** 单封详情 ['mail','message',id] */
    message: (id: string): QueryKeyRO => ['mail', 'message', id],
    /** 搜索结果 ['mail','search',q,attach] */
    search: (q: string, attachOnly: boolean): QueryKeyRO => ['mail', 'search', q, attachOnly],
    /** 设置 ['mail','settings'] */
    settings: ['mail', 'settings'] as const,
    /** 应用专用密码 ['mail','appPasswords'] */
    appPasswords: ['mail', 'appPasswords'] as const,
    /** 可见共享邮箱 ['mail','shared'] */
    shared: ['mail', 'shared'] as const,
    /** 共享邮箱消息 ['mail','sharedMessages',mailboxId,folder] */
    sharedMessages: (mailboxId: string, folder: string = 'inbox'): QueryKeyRO => [
      'mail', 'sharedMessages', mailboxId, folder,
    ],
  },
  auth: {
    session: ['auth', 'session'] as const,
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
    /** 权限点字典 ['admin','permPoints']（API-ADM-02 服务端权威清单；版本演进时失效重拉） */
    permPoints: ['admin', 'permPoints'] as const,
    /** AI 供应商列表 ['admin','aiProviders']（0023；CRUD 后失效） */
    aiProviders: ['admin', 'aiProviders'] as const,
    /** fast/strong 默认路由 ['admin','aiRoutes']（PUT 后失效） */
    aiRoutes: ['admin', 'aiRoutes'] as const,
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
  'mail.new': [['mail', 'summary'], ['mail', 'messages'], ['mail', 'shared'], ['mail', 'sharedMessages']], // 邮箱角标/列表/共享邮箱（MAI，22 §6.2）
  'perm.changed': [], // 权限变更（03 §4）：不走缓存失效——App 壳层重拉 /me/permissions 刷新 auth store（导航显隐实时收窄）
};
