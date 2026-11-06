/** 设置页公共提示条：该页设置项由服务端策略统一下发，当前为界面骨架（不落本地存储） */

import { CloudOff } from 'lucide-react';

export function ServerDrivenNote() {
  return (
    <div className="settings-note">
      <CloudOff size={14} />
      本页设置项将由服务端策略统一下发与同步（策略中心，D10），当前为界面骨架，仅本地演示态、不持久化
    </div>
  );
}
