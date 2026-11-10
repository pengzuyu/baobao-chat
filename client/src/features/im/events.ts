/**
 * IM 对外 bus 事件登记（D03 §8）：
 * 通过 declare module 扩充 shared/bus 的 BusEvents（类型安全声明合并）。
 */

declare module '../../shared/bus' {
  interface BusEvents {
    /** 总未读变化 → app 壳导航徽标 + 托盘（win_set_badge） */
    'im:unread-changed': { total: number; mention: number };
    /** 打开图片查看器 → files(D06) */
    'im:preview-image': { fileId: string; convId: string };
  }
}

export {};
