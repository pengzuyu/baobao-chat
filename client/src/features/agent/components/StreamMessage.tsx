/**
 * 会话流消息行（PAG-03 §3.3）：
 * - 用户消息：右侧主色气泡（Agent 侧渲染已由 TurnBubble 回合气泡承载——
 *   2026-11-11 过程区统一卡片化，思考折叠卡复用 shared/AgentProcessCard ThinkingCollapse，
 *   旧 StreamMessage/ReasoningCollapse 随之退役删除）
 * - MarkdownText 已移 shared/components（D18 内嵌卡复用）；本文件 re-export 供日报页等既有消费方。
 * - D26-O6：agent-row/agent-bubble 类退役——内联 token（黑白反色：主色底+基色字）。
 */

import { memo } from 'react';
import { theme } from 'antd';
import { MarkdownText } from '../../../shared/components/MarkdownText';

export { MarkdownText };

/** 用户消息（memo：流式期间 store 每 delta set，历史行跳过重渲，2026-11-11 卡顿修复） */
export const UserMessage = memo(function UserMessage({ text }: { text: string }) {
  const { token } = theme.useToken();
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', maxWidth: '88%' }}>
      <div
        style={{
          padding: '8px 12px',
          borderRadius: token.borderRadiusLG,
          borderTopRightRadius: 2,
          fontSize: token.fontSize,
          wordBreak: 'break-word',
          minWidth: 0,
          whiteSpace: 'pre-wrap',
          // 黑白反色主题：主色底 + 基底色字（亮=黑底白字 / 暗=白底黑字）
          background: token.colorPrimary,
          color: token.colorBgBase,
        }}
      >
        {text}
      </div>
    </div>
  );
});
