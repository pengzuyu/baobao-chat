/**
 * 全局连接状态机（shared/store，D01 §12.2 规则 5：连接/在线为全局态）：
 * online / connecting / offline 三态 + 全局横幅文案（六态 offline 落点）。
 */

import { create } from 'zustand';
import { wsClient } from '../api/ws';

export type ConnectionStatus = 'online' | 'connecting' | 'offline';

interface ConnectionState {
  status: ConnectionStatus;
  /** 第 N 次重连尝试（横幅展示） */
  reconnectAttempt: number;
  /** 降级提示文案（六态 degraded：顶部黄条，如"未读数更新可能延迟"） */
  degradedText: string | null;

  setStatus: (status: ConnectionStatus, attempt?: number) => void;
  setDegraded: (text: string | null) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'offline',
  reconnectAttempt: 0,
  degradedText: null,
  setStatus: (status, attempt = 0) =>
    set((s) => (s.status === status && s.reconnectAttempt === attempt ? s : { status, reconnectAttempt: attempt })),
  setDegraded: (text) => set({ degradedText: text }),
}));

/** 应用装配期调用：把 WsClient 状态机接到全局 store */
export function bindWsToConnectionStore(): void {
  wsClient.onStateChange = (status, attempt) => {
    const mapped: ConnectionStatus = status === 'online' ? 'online' : status === 'connecting' ? 'connecting' : 'offline';
    useConnectionStore.getState().setStatus(mapped, attempt);
  };
}
