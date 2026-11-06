/**
 * IM 核心类型（D03 §6.3 子集；正式版与服务端 schema 同源生成，14 篇 §8）。
 */

export type ConvType = 1 | 2 | 3; // 1 单聊 / 2 群聊 / 3 广播群

export type MsgType =
  | 'text'
  | 'image'
  | 'file'
  | 'audio_clip'
  | 'video'
  | 'doc_card'
  | 'agent_card'
  | 'merge_forward'
  | 'system'
  | 'call_card';

export type MsgLocalState = 'sending' | 'sent' | 'failed'; // 乐观更新本地态（S1 状态机）

export interface Mention {
  uid: string;
  all: boolean;
  range: [number, number];
}

/** 消息体（骨架阶段覆盖 text 与附件占位；全集见 D03 §6.3） */
export type MessageBody = { text: string } | { fileId: string; name?: string } | Record<string, never>;

export interface Message {
  msgId: string;
  convId: string;
  /** 会话内服务端全序；sending 本地临时序取负数置底（D03 INT-IM-01） */
  seq: number;
  clientMsgId: string;
  senderId: string;
  /** 冗余发送人名称（正式版经成员表解析） */
  senderName: string;
  type: MsgType;
  body: MessageBody;
  mentions?: Mention[];
  replyToSeq?: number;
  status: 1 | 2 | 3; // 1 normal / 2 recalled / 3 edited
  editedAt?: number;
  ts: number;
  /** 仅本端消息：sending/sent/failed（乐观更新） */
  localState?: MsgLocalState;
}

export interface UserConvState {
  pinned: boolean;
  mute: boolean;
  draft: string;
  readSeq: number;
  unreadBadge: number;
  mentionUnread: boolean;
}

export interface Conversation {
  id: string;
  type: ConvType;
  name: string;
  avatarFileId?: string;
  ownerId?: string;
  latestSeq: number;
  /** 最新消息摘要（类型化文案如 [图片]，D03 §3.1） */
  lastMsgDigest?: string;
  lastMsgTs?: number;
  memberCount: number;
  status: 1 | 2; // 1 active / 2 dissolved
  my?: UserConvState;
}

/** msg.send 的 ack payload（幂等重试返回原 seq，D03 §5.2） */
export interface SendAck {
  seq: number;
  msgId: string;
  ts: number;
}

/** msg.new 推送 payload（snake 字段，D03 §5.3） */
export interface MsgNewPayload {
  msg_id: string;
  conv_id: string;
  seq: number;
  client_msg_id: string;
  sender_id: string;
  type: MsgType;
  body: MessageBody;
  mentions?: Mention[];
  reply_to_seq?: number;
  status: 1 | 2 | 3;
  ts: number;
}
