/**
 * 多选批量条（PIM-10a / INT-IM-14，D03 §3.10）：进入多选后替换会话头。
 * `已选 N [转发][收藏][复制][合并转发] [取消]`：
 * - 复制仅选中全为 text 时可用（否则 disabled+tooltip）
 * - 转发=弹窗默认逐条；合并转发=弹窗默认合并（方式 radio 在弹窗内可改）
 * - Esc/点空白退出由 ChatPage 接线（本组件只发取消动作）
 * D26 antd 换装：Flex+Tag 计数+shared Button（multi-select-* 自研类退役）。
 */

import { Flex, Tag, theme } from 'antd';
import { Copy, CornerUpRight, ListOrdered, Star, X } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';

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
  const { token } = theme.useToken();
  return (
    <Flex
      component="header"
      align="center"
      gap={12}
      data-testid="multi-select-bar"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 'var(--bbc-z-sticky)',
        flexShrink: 0,
        height: 52,
        padding: '0 16px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorPrimaryBg,
      }}
    >
      <Tag data-testid="ms-count" style={{ marginInlineEnd: 0, flexShrink: 0 }}>
        已选 {count} 条
      </Tag>
      <Flex align="center" gap={4} wrap="wrap" style={{ flex: 1, minWidth: 0 }}>
        <Button
          variant="text"
          size="small"
          icon={<CornerUpRight size={14} />}
          data-testid="ms-forward"
          disabled={count === 0}
          onClick={onForward}
          title="逐条转发所选消息"
        >
          转发
        </Button>
        <Button
          variant="text"
          size="small"
          icon={<ListOrdered size={14} />}
          data-testid="ms-merge"
          disabled={count === 0}
          onClick={onMergeForward}
          title="合并为一条聊天记录转发（≤30 条）"
        >
          合并转发
        </Button>
        <Button
          variant="text"
          size="small"
          icon={<Star size={14} />}
          data-testid="ms-favorite"
          disabled={count === 0}
          onClick={onFavorite}
          title="收藏所选消息"
        >
          收藏
        </Button>
        <Button
          variant="text"
          size="small"
          icon={<Copy size={14} />}
          data-testid="ms-copy"
          disabled={count === 0 || !copyEnabled}
          onClick={onCopy}
          title={copyEnabled ? '复制所选文本' : '仅支持全部为文本消息时复制'}
        >
          复制
        </Button>
      </Flex>
      <Button
        variant="text"
        size="small"
        icon={<X size={15} />}
        data-testid="ms-cancel"
        onClick={onCancel}
        title="退出多选（Esc）"
      >
        取消
      </Button>
    </Flex>
  );
}
