/**
 * 会话流消息行（PAG-03 §3.3）：
 * - 用户消息：右侧主色浅底气泡（Agent 侧渲染已由 TurnBubble 回合气泡承载——
 *   2026-11-11 过程区统一卡片化，思考折叠卡复用 shared/AgentProcessCard ThinkingCollapse，
 *   旧 StreamMessage/ReasoningCollapse 随之退役删除）
 * - MarkdownText 已移 shared/components（D18 内嵌卡复用）；本文件 re-export 供日报页等既有消费方。
 */

import { memo } from 'react';
import { MarkdownText } from '../../../shared/components/MarkdownText';

export { MarkdownText };

/** 用户消息（memo：流式期间 store 每 delta set，历史行跳过重渲，2026-11-11 卡顿修复） */
export const UserMessage = memo(function UserMessage({ text }: { text: string }) {
  return (
    <div className="agent-row agent-row--user">
      <div className="agent-bubble agent-bubble--user">{text}</div>
    </div>
  );
});
