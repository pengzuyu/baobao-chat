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

/** 引用快照（服务端 ext.reply_digest，D03 §5.2） */
export interface ReplyDigest {
  sender_id: string;
  sender_name?: string;
  type: MsgType | string;
  digest: string;
  seq: number;
}

/** 消息扩展（服务端 ext；reactions 为全量快照 emoji→uid[]） */
export interface MsgExt {
  reactions?: Record<string, string[]>;
  reply_digest?: ReplyDigest;
}

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
  ext?: MsgExt;
  status: 1 | 2 | 3; // 1 normal / 2 recalled / 3 edited
  editedAt?: number;
  editVersion?: number;
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
  sender_name?: string;
  type: MsgType;
  body: MessageBody;
  mentions?: Mention[];
  reply_to_seq?: number;
  ext?: MsgExt;
  status: 1 | 2 | 3;
  ts: number;
}

/** msg.recall 推送（D03 §5.3；seq 不断裂，端内原地转占位） */
export interface MsgRecallPayload {
  msg_id: string;
  conv_id: string;
  seq: number;
  operator_id: string;
  ts: number;
}

/** msg.updated 推送（编辑全端原地更新） */
export interface MsgUpdatedPayload {
  msg_id: string;
  conv_id: string;
  seq: number;
  body: { text: string };
  edited_at: number;
  edit_version: number;
}

/** msg.reaction.new 推送（全量快照，端侧幂等合并） */
export interface MsgReactionNewPayload {
  msg_id: string;
  conv_id: string;
  seq: number;
  reactions: Record<string, string[]>;
}

/** msg.typing 推送（瞬时；TTL 5s 端内过期，D03 INT-IM-11） */
export interface TypingPushPayload {
  conv_id: string;
  user_id: string;
}

/** conv.updated kind=state 推送（本人多端会话态同步，D03 §10-1） */
export interface ConvStatePushPayload {
  conv_id: string;
  kind: 'state';
  state: { pinned?: boolean; mute?: boolean; draft?: string };
  applied: { pinned: boolean; mute: boolean; draft: string };
}

/** 合并转发子条目（merge_forward body.items） */
export interface MergeItem {
  sender_id: string;
  sender_name?: string;
  type: MsgType | string;
  digest: string;
  origin_conv: string;
  origin_seq: number;
}
