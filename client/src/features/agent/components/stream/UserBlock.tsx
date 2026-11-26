/**
 * 用户消息气泡（D33 拍板 #1 修订 2026-11-17 二改：回归右对齐主色气泡——
 * 黑白反色：主色底+基色字，token 随 D27 主题/accent 切换联动；agent 侧保持平铺流）。
 * memo：流式期间 store 每 delta set，历史行跳过重渲。
 * 附件（2026-11-26）：文字段+附件段同气泡分段（图片网格/文件卡，见 AttachmentList）；
 * 历史回放条目同构渲染（WAL attachments 投影）。
 */

import { memo } from 'react';
import { theme } from 'antd';
import { AttachmentList } from '../../../../shared/attachments/components';
import type { AttachmentMeta } from '../../../../shared/attachments';

export const UserBlock = memo(function UserBlock({ text, attachments }: { text: string; attachments?: AttachmentMeta[] }) {
  const { token } = theme.useToken();
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', alignSelf: 'stretch' }}>
      <div
        style={{
          maxWidth: '88%',
          padding: '8px 12px',
          borderRadius: token.borderRadiusLG,
          borderTopRightRadius: 2,
          fontSize: token.fontSize,
          lineHeight: 1.7,
          wordBreak: 'break-word',
          minWidth: 0,
          whiteSpace: 'pre-wrap',
          background: token.colorPrimary,
          color: token.colorBgBase,
        }}
      >
        {attachments && attachments.length > 0 ? <AttachmentList attachments={attachments} /> : null}
        {text}
      </div>
    </div>
  );
});
