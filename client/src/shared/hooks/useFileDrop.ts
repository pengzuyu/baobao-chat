/**
 * 文件拖拽接入 hook（2026-11-26「文件选择全功能点支持拖拽」）：
 * 让所有文件选择功能点（IM 发文件/邮件附件/日历导入/贴纸/表情/批量导入用户等）
 * 除点击打开选择框外，还能把文件直接拖进对应区域。
 *
 * 背景（为什么必须有全局兜底）：Tauri v2 同一窗口「网页层拖拽（HTML5 事件）」与
 * 「原生拖拽（tauri://drag-drop 拿绝对路径）」互斥——tauri.conf.json 已把 main 窗口
 * `dragDropEnabled` 设为 false，HTML5 dragenter/over/leave/drop 才能到达网页层。
 * 代价是 WebView 恢复浏览器默认拖放行为：把文件拖到**非目标区**松手会被当成页面
 * 导航直接打开该文件（Windows WebView2 尤其明显）。所以本模块加载时幂等注册
 * window 级 dragover/drop preventDefault 兜底（不 stopPropagation，不干扰目标区处理）；
 * 全局兜底放在本 hook 文件而非 App.tsx，是为了让「引入即生效」且不与其它在途改动纠缠。
 *
 * 用法：
 *   const { isOver, dropProps } = useFileDrop({
 *     onFiles: (files) => pickFile(files[0]),      // multiple 缺省只回传首个
 *     accept: 'image/*',                            // 与 <input accept> 同语法，可省
 *     onReject: () => message.warning('仅支持图片'), // 全被 accept 过滤时回调，可省
 *   });
 *   <div {...dropProps} style={isOver ? highlight : undefined}>…</div>
 *
 * 注意：
 * - 非文件拖入（拖文本/页面内选中内容）不激活目标区也不接管 drop，行为与浏览器一致；
 * - MessageBubble 的「文件卡片拖出」是纯 web 层行为，不受本改造影响。
 */

import { useCallback, useRef, useState } from 'react';

export interface UseFileDropOptions {
  /** 拖入文件（已过 accept 过滤；multiple=false 时仅含首个） */
  onFiles: (files: File[]) => void;
  /** 与 <input accept> 同语法：MIME（image/*）或扩展名（.zip,.xlsx），缺省不过滤 */
  accept?: string;
  /** 缺省 false=多拖只取首个（与点击单选语义对齐） */
  multiple?: boolean;
  /** true 时完全让路（不接管 drop，落回全局兜底防导航） */
  disabled?: boolean;
  /** 拖入了文件但全部被 accept 过滤掉时回调（参数=被滤掉的个数），供调用方提示 */
  onReject?: (rejected: number) => void;
}

export interface FileDropProps {
  onDragEnter: (e: React.DragEvent<HTMLElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLElement>) => void;
  onDrop: (e: React.DragEvent<HTMLElement>) => void;
}

/** 全局兜底只注册一次（模块可能被多个页面引入） */
let globalGuardInstalled = false;

function ensureGlobalDropGuard(): void {
  if (globalGuardInstalled || typeof window === 'undefined') return;
  globalGuardInstalled = true;
  // capture 阶段只 preventDefault 防导航，不拦截后续传播——目标区的 drop 处理照常进行
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

// 模块加载即安装（「引入即生效」；Tauri SPA 无 SSR，window 恒存在）
ensureGlobalDropGuard();

/** accept 单条匹配：MIME 精确/通配（image/*）或扩展名（.png），大小写不敏感 */
function matchAccept(file: File, rules: string[]): boolean {
  const type = (file.type || '').toLowerCase();
  const name = file.name.toLowerCase();
  return rules.some((rule) => {
    const r = rule.trim().toLowerCase();
    if (!r) return false;
    if (r.startsWith('.')) return name.endsWith(r);
    if (r.endsWith('/*')) return type.startsWith(r.slice(0, -1)); // 'image/*' → 'image/'
    return type === r;
  });
}

export function useFileDrop(options: UseFileDropOptions): { isOver: boolean; dropProps: FileDropProps } {
  const { onFiles, accept, multiple = false, disabled = false, onReject } = options;
  const [isOver, setIsOver] = useState(false);
  // dragenter/dragleave 在子元素间移动会成对触发，用计数器防高亮闪烁；ref 保证回调闭包最新
  const depthRef = useRef(0);
  const optRef = useRef({ onFiles, accept, multiple, disabled, onReject });
  optRef.current = { onFiles, accept, multiple, disabled, onReject };

  const isFileDrag = (e: React.DragEvent<HTMLElement>): boolean =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');

  const onDragEnter = useCallback((e: React.DragEvent<HTMLElement>) => {
    const opt = optRef.current;
    if (opt.disabled || !isFileDrag(e)) return;
    e.preventDefault(); // dragover 前置信号，允许后续 drop
    depthRef.current += 1;
    setIsOver(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent<HTMLElement>) => {
    const opt = optRef.current;
    if (opt.disabled || !isFileDrag(e)) return;
    e.preventDefault(); // 不 preventDefault 浏览器判定不可落，drop 不触发
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLElement>) => {
    const opt = optRef.current;
    if (opt.disabled || !isFileDrag(e)) return;
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setIsOver(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent<HTMLElement>) => {
    const opt = optRef.current;
    depthRef.current = 0;
    setIsOver(false);
    if (opt.disabled || !isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation(); // 防冒到外层同语义 drop 区（如 Modal 套输入区）造成二次接住
    const all = Array.from(e.dataTransfer?.files ?? []);
    if (all.length === 0) return;
    const rules = (opt.accept ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const filtered = rules.length ? all.filter((f) => matchAccept(f, rules)) : all;
    if (filtered.length === 0) {
      opt.onReject?.(all.length);
      return;
    }
    opt.onFiles(opt.multiple ? filtered : filtered.slice(0, 1));
  }, []);

  return { isOver, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
