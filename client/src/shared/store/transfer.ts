/**
 * 传输偏好全局态（D01 §12.2-5 设备偏好归 shared/store / EXECUTION-PLAN D13）：
 * - 下载目录 + 上/下载限速：**设备级配置**（跨端不同设备各异），localStorage
 *   持久化（主题同款口径——UI/设备偏好不受"业务数据禁 localStorage"红线约束）
 * - 限速消费方：Rust 传输引擎（02 篇壳持有传输；fetch/XHR 无原生限速，
 *   分块节流随引擎落地）——v0.1 存储接线+页面真下发，引擎消费登记
 * - 下载目录消费方：文件落盘通道（票据下载经 Rust 侧 reqwest 落盘随引擎；
 *   当前 window.open 浏览器下载走系统目录）——目录选择经 tauri-plugin-dialog
 */

import { create } from 'zustand';

export type SpeedLimit = 'none' | '1' | '4' | '10'; // MB/s

const STORAGE_KEY = 'bbw-transfer';

export interface TransferPref {
  downloadDir: string; // 空=默认（~/Downloads/BaobaoWork，随引擎落盘时使用）
  upLimit: SpeedLimit;
  downLimit: SpeedLimit;
}

const DEFAULT_PREF: TransferPref = { downloadDir: '', upLimit: 'none', downLimit: 'none' };

function readInitial(): TransferPref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREF;
    const p = JSON.parse(raw) as Partial<TransferPref>;
    const limitOk = (v: unknown): v is SpeedLimit => v === 'none' || v === '1' || v === '4' || v === '10';
    return {
      downloadDir: typeof p.downloadDir === 'string' ? p.downloadDir : '',
      upLimit: limitOk(p.upLimit) ? p.upLimit : 'none',
      downLimit: limitOk(p.downLimit) ? p.downLimit : 'none',
    };
  } catch {
    return DEFAULT_PREF;
  }
}

interface TransferState {
  pref: TransferPref;
  setDownloadDir: (dir: string) => void;
  setUpLimit: (v: SpeedLimit) => void;
  setDownLimit: (v: SpeedLimit) => void;
}

function persist(pref: TransferPref): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pref));
  } catch {
    // 隐私模式：静默（会话内生效）
  }
}

export const useTransferStore = create<TransferState>((set, get) => ({
  pref: readInitial(),
  setDownloadDir: (dir) => {
    const pref = { ...get().pref, downloadDir: dir };
    persist(pref);
    set({ pref });
  },
  setUpLimit: (v) => {
    const pref = { ...get().pref, upLimit: v };
    persist(pref);
    set({ pref });
  },
  setDownLimit: (v) => {
    const pref = { ...get().pref, downLimit: v };
    persist(pref);
    set({ pref });
  },
}));
