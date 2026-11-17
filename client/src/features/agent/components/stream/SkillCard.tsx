/**
 * 技能卡（D33 §3.1）：tool=skill 显式加载的专属形态——
 * 头行（Puzzle 图标 + 「技能」+ args.name + 状态）+ 展开体=技能正文
 * （结果即注入上下文的完整规范，等宽块滚动预览）。
 */

import { memo, useEffect, useState } from 'react';
import { Spin, Typography, theme } from 'antd';
import { ChevronRight, Puzzle } from 'lucide-react';
import type { StreamItem } from '../../store/agent';

type ToolItem = Extract<StreamItem, { kind: 'tool' }>;

const monoBlockStyle = {
  fontFamily: 'var(--bbc-font-mono)',
  fontSize: 12,
  background: 'rgba(127, 134, 145, 0.14)',
  borderRadius: 4,
  padding: '8px 12px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  maxHeight: 300,
  overflowY: 'auto',
  margin: 0,
} as const;

export const SkillCard = memo(function SkillCard({ item }: { item: ToolItem }) {
  const { token } = theme.useToken();
  const { call, result } = item;
  const running = !result;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // 加载完成自动展开一次让用户看见正文；再点击收起（运行中展开占位）
    if (result) setOpen(true);
  }, [result]);
  const name = typeof call.args.name === 'string' ? call.args.name : '(未知名)';
  const notFound = result && result.exitCode === 1;

  return (
    <div
      style={{
        alignSelf: 'stretch',
        borderLeft: `2px solid ${running ? token.colorPrimary : notFound ? token.colorWarning : token.colorBorderSecondary}`,
        paddingLeft: 10,
        margin: '2px 0',
      }}
    >
      <button
        type="button"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 0',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          fontSize: 13,
          textAlign: 'left',
          height: 'auto',
          minWidth: 0,
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight
          size={12}
          aria-hidden
          style={{ color: token.colorTextQuaternary, flexShrink: 0, transition: 'transform 0.15s ease', transform: open ? 'rotate(90deg)' : undefined }}
        />
        <Puzzle size={13} aria-hidden style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
        <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
          技能
        </Typography.Text>
        <Typography.Text
          code
          copyable={false}
          style={{ fontSize: 12, minWidth: 0, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: 'transparent', border: 'none', padding: 0 }}
        >
          {name}
        </Typography.Text>
        <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
          {running ? (
            <Spin size="small" aria-hidden />
          ) : (
            <Typography.Text type={notFound ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
              {notFound ? '未找到' : '已加载'}
            </Typography.Text>
          )}
        </span>
      </button>
      {open ? (
        <div style={{ padding: '6px 0 6px 18px', minWidth: 0 }}>
          <pre style={monoBlockStyle}>{result?.summary ?? '（加载中…）'}</pre>
        </div>
      ) : null}
    </div>
  );
});
