/**
 * 待同步池响应式镜像（2026-11-14 隐私裁决）：
 * IndexedDB 真源（embedded.ts readPendingPool 族）+ zustand 视图态——
 * EmbeddedAgentSync 回合收口写入（add），EmbeddedPrivateCards 消费渲染
 * （load/sync/dismiss）。sync busy 按 item.id 防重入。
 */

import { create } from 'zustand';
import {
  addPendingRound,
  readPendingPool,
  removePendingRound,
  syncRoundToConv,
  type PendingAgentRound,
} from './embedded';

const EMPTY_LIST: PendingAgentRound[] = [];

interface PendingState {
  byConv: Record<string, PendingAgentRound[]>;
  /** item.id → 同步落流进行中（按钮 loading/防重入） */
  syncing: Record<string, boolean>;
  load: (convId: string) => Promise<void>;
  add: (convId: string, item: PendingAgentRound) => Promise<void>;
  dismiss: (convId: string, id: string) => Promise<void>;
  /** 同步到会话：仅结论卡落流 + 出池；失败保留可重试（返回 false） */
  sync: (convId: string, item: PendingAgentRound) => Promise<boolean>;
}

export const usePendingRounds = create<PendingState>((set, get) => ({
  byConv: {},
  syncing: {},

  load: async (convId) => {
    const pool = await readPendingPool();
    const list = pool[convId] ?? EMPTY_LIST;
    // 仅在真源变化时替换（挂载/回合切换多次 load 不闪）
    const cur = get().byConv[convId];
    if (cur === list) return;
    set((s) => ({ byConv: { ...s.byConv, [convId]: list } }));
  },

  add: async (convId, item) => {
    // 先乐观入视图再落库（写入器可能随流事件重跑——addPendingRound 幂等兜底）
    set((s) => {
      const list = s.byConv[convId] ?? EMPTY_LIST;
      if (list.some((x) => x.id === item.id)) return s;
      return { byConv: { ...s.byConv, [convId]: [...list, item] } };
    });
    await addPendingRound(convId, item);
  },

  dismiss: async (convId, id) => {
    set((s) => {
      const list = s.byConv[convId];
      if (!list) return s;
      return { byConv: { ...s.byConv, [convId]: list.filter((x) => x.id !== id) } };
    });
    await removePendingRound(convId, id);
  },

  sync: async (convId, item) => {
    if (get().syncing[item.id]) return false;
    set((s) => ({ syncing: { ...s.syncing, [item.id]: true } }));
    try {
      await syncRoundToConv(convId, item);
      await get().dismiss(convId, item.id);
      return true;
    } catch {
      return false; // 保留在池中可重试（调用方 message.error 提示）
    } finally {
      set((s) => {
        const { [item.id]: _drop, ...rest } = s.syncing;
        return { syncing: rest };
      });
    }
  },
}));
