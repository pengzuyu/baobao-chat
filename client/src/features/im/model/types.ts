/**
 * IM 核心类型（D03 §6.3 子集；正式版与服务端 schema 同源生成，14 篇 §8）。
 */

export type ConvType = 1 | 2 | 3; // 1 单聊 / 2 群聊 / 3 广播群

export type MsgType =
  | 'text'
  | 'image'
  | 'file'
  | 'audio_clip'
  | 'sticker'
  | 'video'
  | 'agent_card'
  | 'merge_forward'
  | 'system';

/** 乐观更新本地态（S1 状态机）。'local'=纯本地消息（2026-11-25）：永不发送——
 *  IM 内嵌 Agent 的提问气泡与过程卡仅本机可见（复用负序置底排序与
 *  replaceMessages 保留分支两份现有保护，天然不入 outbox/本地消息表） */
export type MsgLocalState = 'sending' | 'sent' | 'failed' | 'local';

export interface Mention {
  uid: string;
  all: boolean;
  range: [number, number];
}

/**
 * 文件/图片消息体（D06 阶段一：上传两步流——先 POST /files/upload 得 file_id 随 body 携带；
 * width/height 仅图片，服务端 image.DecodeConfig 解析后回传）
 */
export interface FileMessageBody {
  file_id: string;
  name?: string;
  size?: number;
  ext?: string;
  width?: number;
  height?: number;
  contentType?: string;
  /** 随图说明文字（image 专用，04 篇 §1.2 第 5 类；渲染于缩略图下方） */
  caption?: string;
  /** 语音条时长（audio_clip/video 专用，ms） */
  duration_ms?: number;
  /** 视频封面帧文件（video 专用；端侧截首帧上传） */
  poster_file_id?: string;
}

/** 合并转发消息体（PIM-10/PIM-11，D03 §3.2）：服务端 merge 落库 shape
 * {title,count,items[{sender_id,sender_name,type,digest,origin_conv,origin_seq}]} */
export interface MergeForwardBody {
  title?: string;
  count?: number;
  items?: MergeItem[];
}

/** 消息体（骨架阶段覆盖 text 与附件；system 为 PIM-12 参数集；全集见 D03 §6.3；call_card 随 rtc 域瘦身移除） */
export type MessageBody =
  /** text 消息体；bot=true 为「AI 名义消息」（2026-11-20：agent 结论经「发送到聊天」
   *  发出——服务端 text 校验只解析 text 字段、body 原文透传落库，渲染侧按 bot 标记
   *  走对方样式：左对齐+AI 头像+「{senderName}的BOT」名义+markdown 渲染） */
  | { text: string; bot?: true }
  | FileMessageBody
  | SystemBody
  | MergeForwardBody
  | Record<string, never>;

/** AI 名义消息判定（type=text 且 body.bot=true）——ChatPage mine 排除与
 *  MessageBubble 渲染分支共用（2026-11-20） */
export function isBotTextMsg(m: Pick<Message, 'type' | 'body'>): boolean {
  return m.type === 'text' && (m.body as { bot?: unknown } | undefined)?.bot === true;
}

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

/** 我的成员角色：1 owner / 2 admin / 3 member / 4 publisher（04 篇 §4.5.1） */
export type MemberRole = 1 | 2 | 3 | 4;

/** 群设置（group_setting；04 篇 §4.5） */
export interface GroupSetting {
  convId?: string;
  joinMode: 1 | 2 | 3; // 1 直接进 2 需审批 3 仅邀请
  invitePolicy: 1 | 2; // 1 全员可邀 2 仅管理
  mentionAllPolicy: 1 | 2 | 3; // 1 全员 2 仅管理 3 禁用
  muteAllUntil?: number; // ms；0/缺省=未开启
  historyVisible: boolean;
  announcement?: string;
  announcementTs?: number;
}

/** 会话成员行（API-IM-05） */
export interface ConversationMember {
  uid: string;
  displayName: string;
  role: MemberRole;
  status: 1 | 2 | 3; // 1 在群 2 已退 3 被移出（S2 状态机）
  muteUntil?: number; // ms
  joinAt: number;
}

export interface Conversation {
  id: string;
  type: ConvType;
  name: string;
  avatarFileId?: string;
  /** 单聊对端 uid（仅 type=1 下发；在线状态点/资料跳转依据，2026-11-17） */
  peerUid?: string;
  ownerId?: string;
  latestSeq: number;
  /** 最新消息摘要（类型化文案如 [图片]，D03 §3.1） */
  lastMsgDigest?: string;
  lastMsgTs?: number;
  memberCount: number;
  status: 1 | 2; // 1 active / 2 dissolved
  my?: UserConvState;
  /** 群设置快照（详情/conv.updated 推送合并，PIM-05） */
  groupSetting?: GroupSetting;
  /** 我的角色（详情/成员事件维护；权限显隐依据） */
  myRole?: MemberRole;
  /** 我被单人禁言至（ms；输入框禁用条，D03 §3.3） */
  myMuteUntil?: number;
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
  /** 编辑后的 body（text 编辑={text}；服务端同一通道） */
  body: MessageBody;
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

/** 系统消息 body（PIM-12：服务端下发参数集，端内按 kind 套中文模板） */
export interface SystemBody {
  kind: string;
  actor?: string;
  actor_name?: string;
  target?: string;
  target_name?: string;
  group?: string;
  extra?: string; // 申请理由 / 角色方向（admin|member）
  until?: number; // 禁言截止 ms
  join_by_apply?: boolean; // member.joined 申请通过路径
  apply_id?: string; // apply.submitted 审批卡关联
}

/** conv.updated 推送内 conv 快照（meta/member/setting/status/announcement 各 kind 携带） */
export interface ConvSnapshot {
  id: string;
  type: ConvType;
  name: string;
  ownerId?: string;
  latestSeq: number;
  lastMsgTs?: number;
  memberCount: number;
  status: 1 | 2;
  groupSetting?: GroupSetting;
}

/** conv.updated 推送（D03 §5.3；kind=member/setting 携带 members_delta；mute_until ms，0=解除） */
export interface ConvUpdatedPushPayload {
  conv_id: string;
  kind: 'meta' | 'member' | 'setting' | 'status' | 'announcement' | 'state';
  conv?: ConvSnapshot;
  operator_id?: string;
  members_delta?: Array<{ uid: string; role: MemberRole; status: 1 | 2 | 3; mute_until: number }>;
}

/** 会话详情（API-IM-03：conversation 全字段 + group_setting + my + 成员概要） */
export interface ConvDetail extends Conversation {
  groupSetting?: GroupSetting;
  myRole?: MemberRole;
  myMuteUntil?: number;
  members: ConversationMember[];
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

/** 通知分组（D03 §3.9 PIM-09 五分组；agent_done=Agent 完成预留） */
export type NotificationKind = 'mention' | 'reply' | 'apply' | 'agent_done' | 'announcement';

/** 通知中心列表项（API-IM-14 REST camel） */
export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  convId?: string;
  msgId?: string;
  /** 会话内定位 seq（mention/reply 点击跳会话闪烁定位依据） */
  seq?: number;
  title: string;
  digest?: string;
  /** 同会话 10s 窗口合并计数（"×N"渲染；1=单条不显示） */
  count: number;
  createdAt: number;
  /** 0/缺省=未读 */
  readAt?: number;
}

/** notification.new 推送（D03 §5.3 snake；合并命中时 count 为合并后值，真值经 REST 回读） */
export interface NotificationPushPayload {
  id: string;
  kind: NotificationKind;
  conv_id?: string;
  title: string;
  digest?: string;
  count: number;
  ts: number;
}
