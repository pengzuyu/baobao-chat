/**
 * IME 输入法组合态防误发（2026-11-11；同日二修；2026-11-17 三修）：
 * macOS WKWebView（Safari 系内核）上，输入法**确认候选的 Enter** 触发的 keydown
 * 常不带 isComposing=true，且排在 compositionend **之后**派发（与 Chrome 行为
 * 不一致）——单靠 e.nativeEvent.isComposing 挡不住，确认键看起来与真实发送键
 * 一模一样。
 *
 * v2（组合窗+200ms 释放窗）真机暴露新问题：空格选字→紧接 Enter 发送的手速
 * 间隔常仅 50~150ms，全被 200ms 窗误吞——Enter 既没发送、又没拦默认行为，
 * 落成换行（"手速快就变换行"）。v3 两改：
 * 1. 释放窗 200ms→30ms：本窗唯一职责是接住「确认键 keydown 排在 compositionend
 *    之后」的余波——同一物理按键背靠背派发，墙钟差≈0（跨宏任务只差任务边界，
 *    不加墙钟）；人手两次独立按键（空格→Enter/Enter→Enter）物理极限 ≥40ms。
 *    30ms 干净分开两类，快手的真实发送不再被误吞。
 * 2. 被吞的 Enter 由调用方 preventDefault：余波键既不发送也不再插入换行。极端
 *    手速 <30ms 撞进窗内时代价降为「本次 Enter 无效，再按一次」，不产生脏换行。
 *
 * 用法（三态决策）：
 *   const { imeEnterDecision, imeCompositionProps } = useImeGuard();
 *   <textarea {...imeCompositionProps} onKeyDown={(e) => {
 *     if (e.key === 'Enter' && !e.shiftKey) {
 *       const d = imeEnterDecision(e.nativeEvent);
 *       if (d === 'swallow') e.preventDefault();                   // 余波：吞掉（不发送不换行）
 *       else if (d === 'send') { e.preventDefault(); submit(); }  // 放行发送
 *       // 'ime'：组合进行中，交给输入法处理确认，勿拦截
 *     }
 *   }} />
 */

import { useCallback, useRef } from 'react';

/** compositionEnd 后的确认键余波窗（ms）——取值依据见头部 v3 说明 */
const IME_TRAIL_WINDOW_MS = 30;

/** 无修饰 Enter 的三态处置 */
export type ImeEnterDecision =
  /** 非组合态：放行动作（调用方 preventDefault 后执行发送/面板选中） */
  | 'send'
  /** 组合进行中：交给输入法处理确认（勿 preventDefault，确认候选需要） */
  | 'ime'
  /** 组合刚结束的确认键余波：preventDefault 吞掉（不发送也不换行） */
  | 'swallow';

export function useImeGuard() {
  const composingRef = useRef(false);
  const endedAtRef = useRef(0);

  const imeCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);
  const imeCompositionEnd = useCallback(() => {
    composingRef.current = false;
    endedAtRef.current = Date.now();
  }, []);
  const imeEnterDecision = useCallback((native: KeyboardEvent): ImeEnterDecision => {
    if (composingRef.current || native.isComposing) return 'ime';
    if (Date.now() - endedAtRef.current < IME_TRAIL_WINDOW_MS) return 'swallow';
    return 'send';
  }, []);
  return {
    imeEnterDecision,
    imeCompositionProps: { onCompositionStart: imeCompositionStart, onCompositionEnd: imeCompositionEnd },
  };
}
