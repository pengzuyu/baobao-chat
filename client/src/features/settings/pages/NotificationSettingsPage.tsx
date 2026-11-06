/**
 * 设置 · 通知（D01 §4.2）：界面骨架。
 * 通知策略正式版由服务端统一下发（D10 策略中心 + 推送通道），本页开关仅为
 * 本地演示态（useState，不持久化——业务数据禁止 localStorage，D01 §12.2-5）。
 */

import { useState } from 'react';
import { Select, Switch } from 'antd';
import { ServerDrivenNote } from '../components/ServerDrivenNote';

export function NotificationSettingsPage() {
  const [msgNotify, setMsgNotify] = useState(true);
  const [mentionNotify, setMentionNotify] = useState(true);
  const [dndRange, setDndRange] = useState('off');

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">通知</h2>

      <ServerDrivenNote />

      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">会话消息通知</div>
            <div className="settings-row__desc">新消息桌面通知与红点提醒</div>
          </div>
          <Switch checked={msgNotify} onChange={setMsgNotify} size="small" />
        </div>
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">@我特别提醒</div>
            <div className="settings-row__desc">被提及（含 @所有人）时强提醒</div>
          </div>
          <Switch checked={mentionNotify} onChange={setMentionNotify} size="small" />
        </div>
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">免打扰时段</div>
            <div className="settings-row__desc">时段内通知静默，红点保留</div>
          </div>
          <Select
            size="small"
            style={{ width: 160 }}
            value={dndRange}
            onChange={setDndRange}
            options={[
              { value: 'off', label: '关闭' },
              { value: 'work-night', label: '每天 22:00 - 次日 08:00' },
              { value: 'all-day', label: '全天免打扰' },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
