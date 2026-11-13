/**
 * 知识库 tab 页签状态（D24 真机修正轮 2026-11-13：文章固定右侧 tab 切换）：
 * - 首页 tab（key='home'）恒在第 0 位、不可关闭；点开的文章各占一 tab
 * - 打开=去重入列+激活；关闭=移除并激活相邻（关到首页则回首页）
 * - 会话级状态不持久化（刷新恢复当前 tab 经路由 /kb/d/:docId，tab 列表重建——登记）
 */

import { create } from 'zustand';

export interface KbTab {
  /** 'home'=首页固定 tab；文章 tab=docId */
  key: string;
  title: string;
  /** 文章 tab 的文档 ID（home 为空） */
  docId?: string;
}

interface KbTabsState {
  tabs: KbTab[];
  activeKey: string;
  /** 打开（或激活既有）文章 tab */
  open: (docId: string, title: string) => void;
  /** 激活指定 tab（仅切换不新建） */
  setActive: (key: string) => void;
  /** 关闭文章 tab（home 拒绝）；返回应激活的 key（供路由跟随） */
  close: (key: string) => string;
}

const HOME: KbTab = { key: 'home', title: '首页' };

export const useKbTabs = create<KbTabsState>((set, get) => ({
  tabs: [HOME],
  activeKey: 'home',
  open: (docId, title) => {
    const { tabs } = get();
    const hit = tabs.find((t) => t.key === docId);
    if (hit) {
      if (hit.title !== title) {
        set({ tabs: tabs.map((t) => (t.key === docId ? { ...t, title } : t)), activeKey: docId });
      } else {
        set({ activeKey: docId });
      }
      return;
    }
    set({ tabs: [...tabs, { key: docId, title, docId }], activeKey: docId });
  },
  setActive: (key) => {
    if (get().tabs.some((t) => t.key === key)) set({ activeKey: key });
  },
  close: (key) => {
    if (key === 'home') return get().activeKey; // 首页固定不可关
    const { tabs, activeKey } = get();
    const idx = tabs.findIndex((t) => t.key === key);
    if (idx < 0) return activeKey;
    const next = tabs.filter((t) => t.key !== key);
    let activate = activeKey;
    if (activeKey === key) {
      // 激活相邻：优先右侧，越界回左侧；空表兜底回首页（next 恒有 home）
      activate = (next[idx] ?? next[Math.max(0, idx - 1)] ?? HOME).key;
    }
    set({ tabs: next, activeKey: activate });
    return activate;
  },
}));
