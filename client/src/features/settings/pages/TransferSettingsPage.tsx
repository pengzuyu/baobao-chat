/**
 * 设置 · 传输（D01 §4.2 / D06 传输管理器）：界面骨架。
 * 下载目录由 Tauri 文件系统 API 提供（后续接入）；限速策略正式版经服务端下发。
 */

import { Select } from 'antd';
import { FolderOpen } from 'lucide-react';
import { ServerDrivenNote } from '../components/ServerDrivenNote';

export function TransferSettingsPage() {
  return (
    <div className="settings-section">
      <h2 className="settings-section__title">传输</h2>

      <ServerDrivenNote />

      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">默认下载目录</div>
            <div className="settings-row__desc">接收文件与图片的落盘位置（Tauri FS 接入后可更改）</div>
          </div>
          <span className="settings-row__value">
            <FolderOpen size={14} /> ~/Downloads/BaobaoWork
          </span>
        </div>
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">上传限速</div>
            <div className="settings-row__desc">大文件上传对带宽的占用上限</div>
          </div>
          <Select
            size="small"
            defaultValue="none"
            style={{ width: 140 }}
            options={[
              { value: 'none', label: '不限速' },
              { value: '1', label: '1 MB/s' },
              { value: '4', label: '4 MB/s' },
              { value: '10', label: '10 MB/s' },
            ]}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">下载限速</div>
            <div className="settings-row__desc">同步/下载流量的带宽上限</div>
          </div>
          <Select
            size="small"
            defaultValue="none"
            style={{ width: 140 }}
            options={[
              { value: 'none', label: '不限速' },
              { value: '1', label: '1 MB/s' },
              { value: '4', label: '4 MB/s' },
              { value: '10', label: '10 MB/s' },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
