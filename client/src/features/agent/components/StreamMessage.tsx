/**
 * 会话流消息行（PAG-03 §3.3）：
 * - 用户消息/回合渲染已由 WorkbenchTurn 全页过程流承载（2026-11-14 ZCode 式改版，
 *   旧 StreamMessage/ReasoningCollapse/TurnBubble 逐步退役删除）
 * - MarkdownText 已移 shared/components（D18 内嵌卡复用）；本文件 re-export 供日报页等既有消费方。
 */

export { MarkdownText } from '../../../shared/components/MarkdownText';
