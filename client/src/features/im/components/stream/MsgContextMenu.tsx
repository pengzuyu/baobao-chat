/**
 * 消息统一右键/长按菜单（D03 §4.1 INT-IM-25）：
 * - 触发：气泡右键（桌面）/ 长按 500ms（触屏，MessageBubble 内合成）——本组件只负责呈现
 * - 分组（条件显隐共用 msgActionsVisible）：
 *   组1 回复 / 引用 / 复制；组2 转发 / 收藏 / 多选；组3 编辑（本人 text ≤5min）/ 撤回（本人 ≤24h）
 * - system 仅「复制」、撤回占位无菜单（由调用方判定后不打开）
 * - 定位：视口坐标 + 渲染后测量翻转（靠右→左移、靠底→上移），Esc / 点空白 / 滚动关闭
 * - 菜单项点击：先关菜单再执行动作（动作全部复用 ChatPage 传入的 handlers）
 * - 菜单开合为局部 useState（ChatPage 持有），不入全局 store
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Forward, ListChecks, Pencil, Quote, Reply, Star, Undo2 } from 'lucide-react';
import type { Message, SystemBody } from '../../model/types';
import { digestOf } from '../../store/im';
import { systemMessageText } from '../../pages/systemMessageRegistry';
import { msgActionsVisible } from './msgActions';

/** 菜单期望出现位置（视口坐标；组件内部做边缘翻转） */
export interface MenuAnchor {
  x: number;
  y: number;
}

export interface MsgMenuActions {
  onReply: (m: Message) => void;
  onQuote: (m: Message) => void;
  onCopy: (m: Message) => void;
  onForward: (m: Message) => void;
  onFavorite: (m: Message) => void;
  onMultiSelect: (m: Message) => void;
  onEdit: (m: Message) => void;
  onRecall: (m: Message) => void;
}

interface MsgContextMenuProps extends MsgMenuActions {
  message: Message;
  myUid: string;
  anchor: MenuAnchor;
  onClose: () => void;
}

/** 复制内容：text 全文；system 模板文案；其余类型化 digest（[图片]/[文件]…） */
export function copyTextOf(msg: Message): string {
  if (msg.type === 'text' && 'text' in msg.body) return msg.body.text;
  if (msg.type === 'system') {
    return 'kind' in msg.body && msg.body.kind
      ? systemMessageText(msg.body as SystemBody)
      : 'text' in msg.body
        ? msg.body.text
        : '群通知';
  }
  return digestOf(msg);
}

/** 单个菜单项（图标 + 文案；danger=撤回红态） */
function MenuItem({
  icon,
  label,
  danger = false,
  action,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  action: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`ctx-menu__item${danger ? ' ctx-menu__item--danger' : ''}`}
      data-testid="msg-context-menu-item"
      data-action={action}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {icon}
      {label}
    </button>
  );
}

export function MsgContextMenu({ message, myUid, anchor, onClose, ...actions }: MsgContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  /** 翻转后的实际位置（先按锚点渲染，测量后校正） */
  const [pos, setPos] = useState({ x: anchor.x, y: anchor.y });
  const vis = msgActionsVisible(message, myUid);

  // 视口边缘翻转：菜单右缘越界 → 左移一个菜单宽；底缘越界 → 上移一个菜单高（留 8px 安全边距）
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let { x, y } = anchor;
    if (x + r.width > window.innerWidth - 8) x = Math.max(8, Math.min(x - r.width, window.innerWidth - r.width - 8));
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, Math.min(y - r.height, window.innerHeight - r.height - 8));
    setPos({ x, y });
  }, [anchor.x, anchor.y, message.msgId]);

  // 关闭时机：Esc / 菜单外按下（含右键点其它处）/ 任意滚动 / 视口变化。
  // 用 pointerdown 而非 click：长按开菜单后随后的 touchend 合成 click 不会误关
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const close = () => onClose();
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true); // capture：消息流等任意滚动容器
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);

  /** 统一出口：先关菜单再执行动作 */
  const run = (fn: (m: Message) => void) => {
    onClose();
    fn(message);
  };

  // 分组存在性（决定组间分隔线）
  const hasGroup1 = vis.reply || vis.quote || vis.copy;
  const hasGroup2 = vis.forward || vis.favorite || vis.multiSelect;
  const hasGroup3 = vis.edit || vis.recall;

  return createPortal(
    <div
      ref={menuRef}
      className="ctx-menu ctx-menu--msg"
      data-testid="msg-context-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 组1：回复 / 引用 / 复制 */}
      {vis.reply ? (
        <MenuItem icon={<Reply size={14} />} label="回复" action="reply" onClick={() => run(actions.onReply)} />
      ) : null}
      {vis.quote ? (
        <MenuItem icon={<Quote size={14} />} label="引用" action="quote" onClick={() => run(actions.onQuote)} />
      ) : null}
      {vis.copy ? (
        <MenuItem icon={<Copy size={14} />} label="复制" action="copy" onClick={() => run(actions.onCopy)} />
      ) : null}
      {/* 组间分隔线（前组有项才渲染） */}
      {hasGroup2 && hasGroup1 ? <div className="ctx-menu__sep" role="separator" /> : null}
      {/* 组2：转发 / 收藏 / 多选 */}
      {vis.forward ? (
        <MenuItem icon={<Forward size={14} />} label="转发" action="forward" onClick={() => run(actions.onForward)} />
      ) : null}
      {vis.favorite ? (
        <MenuItem icon={<Star size={14} />} label="收藏" action="favorite" onClick={() => run(actions.onFavorite)} />
      ) : null}
      {vis.multiSelect ? (
        <MenuItem
          icon={<ListChecks size={14} />}
          label="多选"
          action="multiselect"
          onClick={() => run(actions.onMultiSelect)}
        />
      ) : null}
      {hasGroup3 && (hasGroup1 || hasGroup2) ? <div className="ctx-menu__sep" role="separator" /> : null}
      {/* 组3：编辑 / 撤回（本人窗口内；与悬浮条同一判定 msgActionsVisible） */}
      {vis.edit ? (
        <MenuItem icon={<Pencil size={14} />} label="编辑" action="edit" onClick={() => run(actions.onEdit)} />
      ) : null}
      {vis.recall ? (
        <MenuItem
          icon={<Undo2 size={14} />}
          label="撤回"
          action="recall"
          danger
          onClick={() => run(actions.onRecall)}
        />
      ) : null}
    </div>,
    document.body,
  );
}
