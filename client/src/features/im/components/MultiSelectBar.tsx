/**
 * 多选批量条（PIM-10a / INT-IM-14，D03 §3.10）：进入多选后替换会话头。
 * `已选 N [转发][收藏][复制][合并转发] [取消]`：
 * - 复制仅选中全为 text 时可用（否则 disabled+tooltip）
 * - 转发=弹窗默认逐条；合并转发=弹窗默认合并（方式 radio 在弹窗内可改）
 * - Esc/点空白退出由 ChatPage 接线（本组件只发取消动作）
 */

import { Copy, CornerUpRight, ListOrdered, Star, X } from 'lucide-react';

interface MultiSelectBarProps {
  /** 已选条数 */
  count: number;
  /** 复制可用：选中全为 text（INT-IM-14） */
  copyEnabled: boolean;
  onForward: () => void;
  onMergeForward: () => void;
  onFavorite: () => void;
  onCopy: () => void;
  onCancel: () => void;
}

export function MultiSelectBar({
  count,
  copyEnabled,
  onForward,
  onMergeForward,
  onFavorite,
  onCopy,
  onCancel,
}: MultiSelectBarProps) {
  return (
    <header className="multi-select-bar" data-testid="multi-select-bar">
      <span className="multi-select-bar__count" data-testid="ms-count">
        已选 {count} 条
      </span>
      <div className="multi-select-bar__actions">
        <button
          type="button"
          className="multi-select-bar__btn"
          data-testid="ms-forward"
          disabled={count === 0}
          onClick={onForward}
          title="逐条转发所选消息"
        >
          <CornerUpRight size={14} />
          转发
        </button>
        <button
          type="button"
          className="multi-select-bar__btn"
          data-testid="ms-merge"
          disabled={count === 0}
          onClick={onMergeForward}
          title="合并为一条聊天记录转发（≤30 条）"
        >
          <ListOrdered size={14} />
          合并转发
        </button>
        <button
          type="button"
          className="multi-select-bar__btn"
          data-testid="ms-favorite"
          disabled={count === 0}
          onClick={onFavorite}
          title="收藏所选消息"
        >
          <Star size={14} />
          收藏
        </button>
        <button
          type="button"
          className="multi-select-bar__btn"
          data-testid="ms-copy"
          disabled={count === 0 || !copyEnabled}
          onClick={onCopy}
          title={copyEnabled ? '复制所选文本' : '仅支持全部为文本消息时复制'}
        >
          <Copy size={14} />
          复制
        </button>
      </div>
      <button
        type="button"
        className="multi-select-bar__cancel"
        data-testid="ms-cancel"
        onClick={onCancel}
        title="退出多选（Esc）"
      >
        <X size={15} />
        取消
      </button>
    </header>
  );
}
