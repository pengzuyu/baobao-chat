/**
 * 附件交互 hooks（2026-11-26）：
 * - useFileDrop：Tauri 原生拖拽（窗口 dragDropEnabled 缺省 true，WebView 的
 *   HTML5 onDrop 不触发——必须走 getCurrentWebview().onDragDropEvent）；
 *   hover 高亮用 enter/leave 计数（over 事件高频，不驱动 React 状态）。
 * - useImagePaste：粘贴事件里取剪贴板图片（getAsFile→ArrayBuffer），交给
 *   调用方落盘（壳 agent_paste_image）。
 */

import { useEffect, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';

/** 原生拖拽文件 → onPaths 回调；返回 hover 态（整窗范围，输入区高亮用） */
export function useFileDrop(enabled: boolean, onPaths: (paths: string[]) => void): boolean {
  const [dragOver, setDragOver] = useState(false);
  const onPathsRef = useRef(onPaths);
  onPathsRef.current = onPaths;

  useEffect(() => {
    if (!enabled) {
      setDragOver(false);
      return;
    }
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let depth = 0;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        if (event.payload.type === 'enter') {
          depth = 1;
          setDragOver(true);
        } else if (event.payload.type === 'over') {
          if (!dragOver) setDragOver(true);
        } else if (event.payload.type === 'leave') {
          depth = Math.max(0, depth - 1);
          if (depth === 0) setDragOver(false);
        } else if (event.payload.type === 'drop') {
          depth = 0;
          setDragOver(false);
          const paths = event.payload.paths;
          if (paths.length > 0) onPathsRef.current(paths);
        }
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => undefined); // 纯浏览器 dev：无原生拖拽事件
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // dragOver 在闭包内只做「已高亮短路」，不作为依赖（避免 over 高频重挂）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return dragOver;
}

/** 粘贴图片 → onImageData（原始字节；调用方走壳命令落盘） */
export function useImagePaste(enabled: boolean, onImageData: (bytes: Uint8Array) => void): void {
  const cbRef = useRef(onImageData);
  cbRef.current = onImageData;

  useEffect(() => {
    if (!enabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (!f) continue;
          e.preventDefault();
          void f
            .arrayBuffer()
            .then((buf) => cbRef.current(new Uint8Array(buf)))
            .catch(() => undefined);
          return;
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [enabled]);
}
