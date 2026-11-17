/**
 * 思考块（D33 §3.5）：流式强制展开 + 段末自动折叠语义沿用共享 ThinkingCollapse
 * （IM 卡同款单一实现），平铺流下的薄壳——未来视觉分叉时在此演进，
 * 不回写 shared（IM 卡不受 D33 影响，拍板 #4）。
 */

import { ThinkingCollapse } from '../../../../shared/components/AgentProcessCard';

export function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  return <ThinkingCollapse text={text} streaming={streaming} />;
}
