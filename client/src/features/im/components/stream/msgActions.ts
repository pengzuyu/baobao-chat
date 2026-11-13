/**
 * 消息动作可见性判定（D03 §4.1 INT-IM-25）：
 * 右键/长按菜单与悬浮操作条共用同一套显隐条件——
 * 组1：回复/引用/复制；组2：转发/收藏/多选；组3：编辑（本人 text ≤5min）/撤回（本人 ≤24h）。
 * - 撤回占位（status=2，含实时转 system 形态与历史真值）：无任何操作
 * - system 消息：仅「复制」文案（§3.12 不参与回执/其余菜单）
 * - 服务端侧动作（转发/收藏/多选/编辑/撤回）须已落服务端（msgId 非空——sending/failed 乐观消息不可达）
 */

import type { Message } from '../../model/types';

/** 编辑窗口（INT-IM-02：仅本人 text 且 ≤5min；3008 超窗由服务端兜底） */
export const MSG_EDIT_WINDOW_MS = 5 * 60 * 1000;
/** 撤回窗口（INT-IM-03：本人 ≤24h；recall_any 权限撤他人属正式版权限矩阵，登记） */
export const MSG_RECALL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 各菜单项/悬浮按钮可见位图 */
export interface MsgActionVisibility {
  /** 组1：回复——插入引用条并聚焦输入框（携带 reply_to_seq 发送） */
  reply: boolean;
  /** 组1：引用——只插入引用条，不预填文本不抢焦点 */
  quote: boolean;
  /** 组1：复制——text 复制全文；非 text 复制类型化 digest（[图片] 等） */
  copy: boolean;
  /** 组2：转发（PIM-10） */
  forward: boolean;
  /** 组2：收藏（INT-IM-06，幂等） */
  favorite: boolean;
  /** 组2：存入知识库（D24 N6：text 消息转存我的笔记） */
  saveKb: boolean;
  /** 组2：多选（INT-IM-14 批量入口） */
  multiSelect: boolean;
  /** 组3：编辑（本人 text ≤5min） */
  edit: boolean;
  /** 组3：撤回（本人 ≤24h） */
  recall: boolean;
}

const NONE: MsgActionVisibility = {
  reply: false,
  quote: false,
  copy: false,
  forward: false,
  favorite: false,
  saveKb: false,
  multiSelect: false,
  edit: false,
  recall: false,
};

/**
 * 统一显隐判定（右键菜单 MsgContextMenu 与悬浮操作条 MessageBubble 复用）。
 * @param msg  目标消息
 * @param myUid 当前用户 uid
 * @param now  当前时间（默认 Date.now()；测试可注入）
 */
export function msgActionsVisible(msg: Message, myUid: string, now: number = Date.now()): MsgActionVisibility {
  // 撤回占位：无菜单（内容已不可见，复制亦无意义）
  if (msg.status === 2) return NONE;
  // 系统消息：仅「复制」模板文案
  if (msg.type === 'system') return { ...NONE, copy: true };
  const serverReachable = !!msg.msgId; // sending/failed 本地乐观消息无服务端 msg_id
  const mine = msg.senderId === myUid;
  return {
    reply: true,
    quote: true,
    copy: true,
    forward: serverReachable,
    favorite: serverReachable,
    saveKb: serverReachable && msg.type === 'text',
    multiSelect: serverReachable,
    edit: serverReachable && mine && msg.type === 'text' && now - msg.ts < MSG_EDIT_WINDOW_MS,
    recall: serverReachable && mine && now - msg.ts < MSG_RECALL_WINDOW_MS,
  };
}

/** 是否存在任一可用动作（全 false 时右键/长按不弹菜单） */
export function hasAnyMsgAction(v: MsgActionVisibility): boolean {
  return Object.values(v).some(Boolean);
}
