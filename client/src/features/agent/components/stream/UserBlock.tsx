/**
 * 用户消息平铺块（D33 拍板 #1：弃右侧主色气泡，全时间线统一平铺风格——
 * 左侧全宽轻边框/浅底块）。memo：流式期间 store 每 delta set，历史行跳过重渲。
 */

import { memo } from 'react';
import { theme } from 'antd';

export const UserBlock = memo(function UserBlock({ text }: { text: string }) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        background: token.colorFillQuaternary,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        padding: '10px 14px',
        fontSize: token.fontSize,
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        minWidth: 0,
        alignSelf: 'stretch',
      }}
    >
      {text}
    </div>
  );
});
