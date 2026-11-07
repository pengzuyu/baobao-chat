/**
 * RTC 对外 bus 事件登记（D04 §8）：
 * 通过 declare module 扩充 shared/bus 的 BusEvents（类型安全声明合并）。
 * im:invoke-call（发起入口）已由 im/events.ts 登记，此处不重复。
 */

declare module '../../shared/bus' {
  interface BusEvents {
    /** 来电到达 → notification（形态/铃声决策；阶段一 rtc 自承接弹窗，预留） */
    'rtc:incoming': { callId: string; callerName: string; video: boolean };
    /** 通话终态 → im（卡片终态）/notification（未接红点） */
    'rtc:call-ended': { callId: string; reason: string; durationSec: number };
  }
}

export {};
