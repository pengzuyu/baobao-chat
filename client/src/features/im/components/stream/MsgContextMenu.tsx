/**
 * 消息统一右键/长按菜单（D03 §4.1 INT-IM-25）：
 * - 触发：气泡右键（桌面）/ 长按 500ms（触屏，MessageBubble 内合成）——本组件只负责呈现
 * - 分组（条件显隐共用 msgActionsVisible）：
 *   组1 回复 / 引用 / 复制；组2 转发 / 收藏 / 多选；组3 编辑（本人 text ≤5min）/ 撤回（本人 ≤24h）
 * - system 仅「复制」、撤回占位无菜单（由调用方判定后不打开）
 * - 定位：antd 无 context menu 组件——portal 到 body + 视口坐标 + 渲染后测量翻转
 *   （靠右→左移、靠底→上移）由本组件自持；菜单内容走 antd Menu（items/divider/danger）
 * - 关闭：Esc / 点空白（pointerdown，长按后合成 click 不误关）/ 任意滚动 / 视口变化
 * - 菜单项点击：先关菜单再执行动作（动作全部复用 ChatPage 传入的 handlers）
 * - 菜单开合为局部 useState（ChatPage 持有），不入全局 store
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Menu, theme } from 'antd';
import type { MenuProps } from 'antd';
import { BookMarked, Copy, Forward, ListChecks, Pencil, Quote, Reply, Star, Undo2 } from 'lucide-react';
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
  /** 存入知识库（D24 N6：文本消息→我的笔记） */
  onSaveToKb: (m: Message) => void;
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

/** 菜单项 label（图标 + 文案；testid/data-action 锚点随 label 走，真机回归用） */
function MenuItemLabel({ icon, label, action }: { icon: React.ReactNode; label: string; action: string }) {
  return (
    <span
      data-testid="msg-context-menu-item"
      data-action={action}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
    >
      {icon}
      {label}
    </span>
  );
}

export function MsgContextMenu({ message, myUid, anchor, onClose, ...actions }: MsgContextMenuProps) {
  const { token } = theme.useToken();
  const menuRef = useRef<HTMLDivElement>(null);
  /** 翻转后的实际位置（先按锚点渲染，测量后校正） */
  const [pos, setPos] = useState({ x: anchor.x, y: anchor.y });
  const vis = msgActionsVisible(message, myUid);
  // 2026-11-26 全员试用收口：知识库域整域「敬请期待」，「存入知识库」入口随域隐藏
  // （内容存了也无入口查看；恢复=删除本行）
  vis.saveKb = false;

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
  const hasGroup2 = vis.forward || vis.favorite || vis.saveKb || vis.multiSelect;
  const hasGroup3 = vis.edit || vis.recall;

  // antd Menu items（key=动作名；divider=组间分隔；danger=撤回红态）
  const items: MenuProps['items'] = [
    ...(vis.reply
      ? [{ key: 'reply', label: <MenuItemLabel icon={<Reply size={14} />} label="回复" action="reply" /> }]
      : []),
    ...(vis.quote
      ? [{ key: 'quote', label: <MenuItemLabel icon={<Quote size={14} />} label="引用" action="quote" /> }]
      : []),
    ...(vis.copy
      ? [{ key: 'copy', label: <MenuItemLabel icon={<Copy size={14} />} label="复制" action="copy" /> }]
      : []),
    ...(hasGroup2 && hasGroup1 ? [{ type: 'divider' as const }] : []),
    ...(vis.forward
      ? [{ key: 'forward', label: <MenuItemLabel icon={<Forward size={14} />} label="转发" action="forward" /> }]
      : []),
    ...(vis.favorite
      ? [{ key: 'favorite', label: <MenuItemLabel icon={<Star size={14} />} label="收藏" action="favorite" /> }]
      : []),
    ...(vis.saveKb
      ? [{ key: 'savekb', label: <MenuItemLabel icon={<BookMarked size={14} />} label="存入知识库" action="savekb" /> }]
      : []),
    ...(vis.multiSelect
      ? [{ key: 'multiselect', label: <MenuItemLabel icon={<ListChecks size={14} />} label="多选" action="multiselect" /> }]
      : []),
    ...(hasGroup3 && (hasGroup1 || hasGroup2) ? [{ type: 'divider' as const }] : []),
    ...(vis.edit ? [{ key: 'edit', label: <MenuItemLabel icon={<Pencil size={14} />} label="编辑" action="edit" /> }] : []),
    ...(vis.recall
      ? [{ key: 'recall', danger: true, label: <MenuItemLabel icon={<Undo2 size={14} />} label="撤回" action="recall" /> }]
      : []),
  ];

  const onMenuClick: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation();
    switch (key) {
      case 'reply':
        run(actions.onReply);
        break;
      case 'quote':
        run(actions.onQuote);
        break;
      case 'copy':
        run(actions.onCopy);
        break;
      case 'forward':
        run(actions.onForward);
        break;
      case 'favorite':
        run(actions.onFavorite);
        break;
      case 'savekb':
        run(actions.onSaveToKb);
        break;
      case 'multiselect':
        run(actions.onMultiSelect);
        break;
      case 'edit':
        run(actions.onEdit);
        break;
      case 'recall':
        run(actions.onRecall);
        break;
      default:
        break;
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      data-testid="msg-context-menu"
      role="menu"
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: token.zIndexPopupBase + 50 }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Menu
        selectable={false}
        mode="vertical"
        items={items}
        onClick={onMenuClick}
        style={{ minWidth: 168, borderInlineEnd: 'none', borderRadius: token.borderRadius, background: token.colorBgContainer }}
      />
    </div>,
    document.body,
  );
}
