/**
 * 设置 · Agent（D01 §4.2 / D08）：界面骨架。
 * 权限模式/紧急停止为 D08 既定约定；三级记忆管理等入口在 Agent 模块阶段实现。
 */

import { Select } from 'antd';
import { Zap } from 'lucide-react';
import { ServerDrivenNote } from '../components/ServerDrivenNote';

export function AgentSettingsPage() {
  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Agent</h2>

      <ServerDrivenNote />

      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">默认权限模式</div>
            <div className="settings-row__desc">Agent 执行写操作的授权级别（D08 权限模式切换器）</div>
          </div>
          <Select
            size="small"
            defaultValue="confirm"
            style={{ width: 150 }}
            options={[
              { value: 'readonly', label: '只读' },
              { value: 'confirm', label: '确认后执行' },
              { value: 'auto', label: '自主执行' },
            ]}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">
              <Zap size={14} className="settings-row__danger-icon" /> 紧急停止
            </div>
            <div className="settings-row__desc">全局快捷键立即中止所有 Agent 任务（D08 紧急停止）</div>
          </div>
          <kbd className="settings-row__kbd">⌘ ⇧ .</kbd>
        </div>
      </div>

      <div className="settings-card settings-card--static">
        <div className="settings-card__head">
          <div className="settings-card__name">三级记忆管理</div>
        </div>
        <div className="settings-card__desc">会话记忆 / 长期偏好 / 企业知识的查看与清除，入口在 /agent/memory（D08）实现后开放</div>
      </div>
    </div>
  );
}
