/** 空态基元（D26-O1 包装化）：内部换 antd Empty（simple 线稿+原生观感），API 不动 */

import { Empty as AntdEmpty } from 'antd';
import type { ReactNode } from 'react';

interface EmptyProps {
  text: string;
  /** 主 CTA（如"发起单聊"），由业务方传入 */
  action?: ReactNode;
}

export function Empty({ text, action }: EmptyProps) {
  return (
    <AntdEmpty image={AntdEmpty.PRESENTED_IMAGE_SIMPLE} description={text}>
      {action ? <div>{action}</div> : undefined}
    </AntdEmpty>
  );
}
