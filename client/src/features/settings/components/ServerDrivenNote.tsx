/** 设置页公共提示条：该页设置项由服务端策略统一下发，当前为界面骨架（不落本地存储）。
 * D26-O3：提示条→antd Alert（settings-note 退役）。 */

import { Alert } from 'antd';
import { CloudOff } from 'lucide-react';

export function ServerDrivenNote() {
  return (
    <Alert
      type="info"
      showIcon
      icon={<CloudOff size={15} />}
      message="本页设置项将由服务端策略统一下发与同步（策略中心，D10），当前为界面骨架，仅本地演示态、不持久化"
      style={{ marginBottom: 16 }}
    />
  );
}
