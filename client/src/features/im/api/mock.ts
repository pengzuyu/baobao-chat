/**
 * IM 桩数据（集中在此，不散落组件；VITE_USE_MOCK=0 关闭后走真实 REST/WS）。
 * mock uid：u-1001=本人（与 auth mock 登录一致）。
 */

import type { Conversation, Message } from '../model/types';

const HOUR = 60 * 60 * 1000;
const now = Date.now();

export const MY_UID = 'u-1001';

export const MOCK_CONVS: Conversation[] = [
  {
    id: 'c-8001',
    type: 1,
    name: '王工',
    latestSeq: 6,
    lastMsgDigest: '收到，我今天先出一版协议评审意见',
    lastMsgTs: now - 5 * 60 * 1000,
    memberCount: 2,
    status: 1,
    my: { pinned: true, mute: false, draft: '', readSeq: 5, unreadBadge: 1, mentionUnread: false },
  },
  {
    id: 'c-8002',
    type: 2,
    name: '客户端联调群',
    latestSeq: 12,
    lastMsgDigest: '我: 三栏布局已经按 D01 落了',
    lastMsgTs: now - 32 * 60 * 1000,
    memberCount: 8,
    status: 1,
    my: { pinned: true, mute: false, draft: '', readSeq: 12, unreadBadge: 0, mentionUnread: false },
  },
  {
    id: 'c-8003',
    type: 2,
    name: '产品周会',
    latestSeq: 40,
    lastMsgDigest: '[文件] 阶段一排期.xlsx',
    lastMsgTs: now - 3 * HOUR,
    memberCount: 16,
    status: 1,
    my: { pinned: false, mute: true, draft: '', readSeq: 36, unreadBadge: 4, mentionUnread: false },
  },
  {
    id: 'c-8004',
    type: 3,
    name: '公司公告',
    latestSeq: 88,
    lastMsgDigest: '关于国庆值班安排的通知',
    lastMsgTs: now - 26 * HOUR,
    memberCount: 2000,
    status: 1,
    my: { pinned: false, mute: true, draft: '', readSeq: 86, unreadBadge: 2, mentionUnread: false },
  },
  {
    id: 'c-8005',
    type: 1,
    name: '测试账号（李雷）',
    latestSeq: 3,
    lastMsgDigest: '[草稿] 这条演示本地草稿',
    lastMsgTs: now - 50 * HOUR,
    memberCount: 2,
    status: 1,
    my: { pinned: false, mute: false, draft: '这条演示本地草稿', readSeq: 3, unreadBadge: 0, mentionUnread: false },
  },
];

function msg(partial: Pick<Message, 'convId' | 'seq' | 'senderId' | 'senderName' | 'type' | 'body'> & { ts: number }): Message {
  return {
    msgId: `m-${partial.convId.slice(2)}-${partial.seq}`,
    clientMsgId: `server-${partial.seq}`,
    status: 1,
    ...partial,
  };
}

export const MOCK_MESSAGES: Record<string, Message[]> = {
  'c-8001': [
    msg({ convId: 'c-8001', seq: 1, senderId: 'u-2002', senderName: '王工', type: 'text', body: { text: 'D01 的六态规范里，offline 是不是要配 outbox 重发队列？' }, ts: now - 2 * HOUR }),
    msg({ convId: 'c-8001', seq: 2, senderId: MY_UID, senderName: '我', type: 'text', body: { text: '对，04 篇定义了 outbox 表，弱网下 sending/failed 的消息都排在那里' }, ts: now - 2 * HOUR + 60_000 }),
    msg({ convId: 'c-8001', seq: 3, senderId: 'u-2002', senderName: '王工', type: 'text', body: { text: '断点那块，M 档列表栏收到 56 是悬停展开抽屉？' }, ts: now - HOUR }),
    msg({ convId: 'c-8001', seq: 4, senderId: MY_UID, senderName: '我', type: 'text', body: { text: '是的，S 档直接列表⇄内容两级导航，左上返回' }, ts: now - HOUR + 30_000 }),
    msg({ convId: 'c-8001', seq: 5, senderId: 'u-2002', senderName: '王工', type: 'system', body: {}, ts: now - 40 * 60_000 }),
    msg({ convId: 'c-8001', seq: 6, senderId: 'u-2002', senderName: '王工', type: 'text', body: { text: '收到，我今天先出一版协议评审意见' }, ts: now - 5 * 60_000 }),
  ],
  'c-8002': [
    msg({ convId: 'c-8002', seq: 10, senderId: 'u-3003', senderName: '赵设计', type: 'text', body: { text: '气泡最大宽 L 档 640，XL 720，气泡尾巴 4px 圆角' }, ts: now - 3 * HOUR }),
    msg({ convId: 'c-8002', seq: 11, senderId: 'u-3003', senderName: '赵设计', type: 'image', body: { file_id: 'f-1', name: '断点示意.png', size: 48210, ext: 'png' }, ts: now - 2.5 * HOUR }),
    msg({ convId: 'c-8002', seq: 12, senderId: MY_UID, senderName: '我', type: 'text', body: { text: '三栏布局已经按 D01 落了' }, ts: now - 32 * 60_000 }),
  ],
  'c-8003': [
    msg({ convId: 'c-8003', seq: 38, senderId: 'u-4004', senderName: 'PM 阿云', type: 'text', body: { text: '阶段一范围：应用壳、认证、IM 三栏骨架' }, ts: now - 5 * HOUR }),
    msg({ convId: 'c-8003', seq: 39, senderId: 'u-4004', senderName: 'PM 阿云', type: 'system', body: {}, ts: now - 4 * HOUR }),
    msg({ convId: 'c-8003', seq: 40, senderId: 'u-4004', senderName: 'PM 阿云', type: 'file', body: { file_id: 'f-9', name: '阶段一排期.xlsx', size: 25600, ext: 'xlsx' }, ts: now - 3 * HOUR }),
  ],
  'c-8004': [
    msg({ convId: 'c-8004', seq: 87, senderId: 'u-9001', senderName: '行政', type: 'text', body: { text: '系统将于周六 02:00 例行维护' }, ts: now - 74 * HOUR }),
    msg({ convId: 'c-8004', seq: 88, senderId: 'u-9001', senderName: '行政', type: 'text', body: { text: '关于国庆值班安排的通知（广播群仅发布者可发言）' }, ts: now - 26 * HOUR }),
  ],
  'c-8005': [
    msg({ convId: 'c-8005', seq: 1, senderId: 'u-5005', senderName: '李雷', type: 'text', body: { text: '登录锁定倒计时的桩账号是哪个来着？' }, ts: now - 51 * HOUR }),
    msg({ convId: 'c-8005', seq: 2, senderId: MY_UID, senderName: '我', type: 'text', body: { text: '账号输入 locked 就行' }, ts: now - 50.5 * HOUR }),
    msg({ convId: 'c-8005', seq: 3, senderId: 'u-5005', senderName: '李雷', type: 'text', body: { text: '好嘞' }, ts: now - 50 * HOUR }),
  ],
};

/** mock 会话当前最大 seq（发送 ack 分配 seq 用） */
export function mockLatestSeq(convId: string): number {
  return MOCK_CONVS.find((c) => c.id === convId)?.latestSeq ?? 0;
}
