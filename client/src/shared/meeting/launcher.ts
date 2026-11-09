/**
 * 会议窗口拉起器（D17 §4，物理位置 shared——被 rtc feature 与组合层共同消费，
 * 不 import 任何 feature，D01 §12.2）：
 * - Tauri 宿主：invoke meeting_start_window（Rust 侧一次性内存 handoff + 动态建窗）
 * - 浏览器（dev/E2E）：返回 false，调用方降级主窗内联通话
 * - 交接字段与 Rust MeetingHandoff 对齐（serde 蛇形默认）
 */

import { invoke } from '@tauri-apps/api/core';

/** Tauri 宿主探测（与 auth store 同口径的轻量版） */
export function isTauriHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 会议窗口交接载荷（token 仅经 Rust 内存信箱一次性传递，不落盘） */
export interface MeetingHandoff {
  token: string;
  refresh_token: string;
  /** access 过期时刻（ms epoch；会议窗口过期前自刷新） */
  expires_at: number;
  uid: string;
  display_name: string;
  /** outgoing1v1 | outgoingGroup | accept1v1 | joinGroup */
  action: 'outgoing1v1' | 'outgoingGroup' | 'accept1v1' | 'joinGroup';
  call_id: string;
  conv_id: string;
  video: boolean;
  peer_uid: string;
  peer_name: string;
}

/** call_id 生成（与 rtcStore 同格式；主窗生成以绑定窗口幂等键） */
let meetingCallSeq = 0;
export function newMeetingCallId(): string {
  meetingCallSeq += 1;
  return `call-${Date.now()}-${meetingCallSeq}`;
}

/**
 * 拉起独立会议窗口。
 * @returns true=窗口已拉起（含同通话幂等聚焦）；false=非 Tauri 宿主或创建失败（调用方降级主窗内联）
 */
export async function launchMeetingWindow(h: MeetingHandoff): Promise<boolean> {
  if (!isTauriHost()) return false;
  try {
    await invoke('meeting_start_window', { handoff: h });
    return true;
  } catch {
    return false;
  }
}
