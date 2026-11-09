/**
 * 设置 · 传输（D01 §4.2 / D06 传输管理器 / D13 接线）：
 * - 下载目录：设备偏好（shared/store/transfer 持久化）——Tauri 宿主经
 *   plugin-dialog 目录选择器更改；浏览器 dev 环境降级为文本输入。
 *   消费方：Rust 传输引擎落盘通道（02 篇，阶段二——当前 window.open 浏览器
 *   下载走系统目录，目录值先随配置就位，登记）。
 * - 上/下载限速：Select 挂 onChange 真下发到 transfer store（持久化）；
 *   分块节流实现随 Rust 传输引擎（fetch/XHR 无原生限速，登记）。
 */

import { useState } from 'react';
import { Select } from 'antd';
import { FolderOpen } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTransferStore, type SpeedLimit } from '../../../shared/store/transfer';

const LIMIT_OPTIONS = [
  { value: 'none', label: '不限速' },
  { value: '1', label: '1 MB/s' },
  { value: '4', label: '4 MB/s' },
  { value: '10', label: '10 MB/s' },
];

/** Tauri 宿主可用性（与 agent/bridge/tauri 同判定口径） */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function TransferSettingsPage() {
  const pref = useTransferStore((s) => s.pref);
  const setDownloadDir = useTransferStore((s) => s.setDownloadDir);
  const setUpLimit = useTransferStore((s) => s.setUpLimit);
  const setDownLimit = useTransferStore((s) => s.setDownLimit);
  // 浏览器降级：文本编辑态
  const [dirInput, setDirInput] = useState('');

  const pickDir = async () => {
    if (!isTauri()) return; // 浏览器环境走文本输入分支
    try {
      const dir = await open({ directory: true, title: '选择默认下载目录' });
      if (typeof dir === 'string' && dir) setDownloadDir(dir);
    } catch {
      // 用户取消/插件异常：静默
    }
  };

  const shownDir = pref.downloadDir || '~/Downloads/BaobaoWork';

  return (
    <div className="settings-section" data-testid="settings-transfer">
      <h2 className="settings-section__title">传输</h2>

      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">默认下载目录</div>
            <div className="settings-row__desc">
              {pref.downloadDir
                ? '接收文件与图片的落盘位置（Rust 传输引擎落盘通道随阶段二消费此配置）'
                : '未设置——当前沿用系统下载目录；Tauri 宿主可点选自定义'}
            </div>
          </div>
          {isTauri() ? (
            <span className="settings-row__value" style={{ gap: 6 }}>
              <FolderOpen size={14} />
              <button
                type="button"
                className="doc-link-btn"
                onClick={() => void pickDir()}
                data-testid="transfer-dir-pick"
                title={shownDir}
              >
                {shownDir}
              </button>
            </span>
          ) : (
            <span className="settings-row__value" style={{ gap: 6 }}>
              <input
                className="settings-dir-input"
                placeholder="~/Downloads/BaobaoWork"
                value={dirInput || pref.downloadDir}
                onChange={(e) => setDirInput(e.target.value)}
                onBlur={() => dirInput && setDownloadDir(dirInput.trim())}
                onKeyDown={(e) => e.key === 'Enter' && dirInput && setDownloadDir(dirInput.trim())}
                data-testid="transfer-dir-input"
              />
            </span>
          )}
        </div>
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">上传限速</div>
            <div className="settings-row__desc">大文件上传对带宽的占用上限（引擎分块节流随阶段二生效）</div>
          </div>
          <Select
            size="small"
            value={pref.upLimit}
            style={{ width: 140 }}
            options={LIMIT_OPTIONS}
            data-testid="transfer-up-limit"
            onChange={(v) => setUpLimit(v as SpeedLimit)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">下载限速</div>
            <div className="settings-row__desc">同步/下载流量的带宽上限（引擎分块节流随阶段二生效）</div>
          </div>
          <Select
            size="small"
            value={pref.downLimit}
            style={{ width: 140 }}
            options={LIMIT_OPTIONS}
            data-testid="transfer-down-limit"
            onChange={(v) => setDownLimit(v as SpeedLimit)}
          />
        </div>
      </div>
    </div>
  );
}
