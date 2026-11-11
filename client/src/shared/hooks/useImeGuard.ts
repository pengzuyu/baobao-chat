/**
 * IME 输入法组合态防误发（2026-11-11；同日二修）：
 * macOS WKWebView（Safari 系内核）上，输入法**确认候选的 Enter** 触发的 keydown
 * 常不带 isComposing=true（与 Chrome 行为不一致）——单靠 e.nativeEvent.isComposing
 * 挡不住，用户打字确认候选时内容被直接发送。
 *
 * 修法（v2 时间窗）：composition 事件跟踪组合窗 + compositionEnd 后短时间窗内
 * 仍视为组合中。v1 用 setTimeout(0) 延迟解除，前提是「compositionEnd 与确认键
 * keydown 同一宏任务」——真机复现此假设不成立（WKWebView 可分属不同宏任务，
 * 定时器在两者之间执行把旗标清掉，确认键漏过=消息被发送）。时间窗 200ms：
 * 跨任务时序全覆盖，且远小于「确认候选→有意发送」的人工双击间隔，不会挡真实发送。
 *
 * 用法：
 *   const { imeComposing, imeCompositionProps } = useImeGuard();
 *   <textarea {...imeCompositionProps} onKeyDown={(e) => {
 *     if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !imeComposing()) submit();
 *   }} />
 */

import { useCallback, useRef } from 'react';

/** compositionEnd 后的保护窗（ms） */
const IME_RELEASE_WINDOW_MS = 200;

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
  /** 组合中，或刚结束仍在保护窗内（跨宏任务时序兜底） */
  const imeComposing = useCallback(
    () => composingRef.current || Date.now() - endedAtRef.current < IME_RELEASE_WINDOW_MS,
    [],
  );
  return { imeComposing, imeCompositionProps: { onCompositionStart: imeCompositionStart, onCompositionEnd: imeCompositionEnd } };
}
