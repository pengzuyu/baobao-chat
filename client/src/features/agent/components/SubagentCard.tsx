/**
 * 子 Agent 行（D16 类型 1 / P0-4 → 2026-11-26 行式重做）：
 * 卡片退役（用户口径：占高太多）→ 与 ToolBlock 同款单行折叠行——
 * 主题色图标（六套 accent 联动）+ 任务摘要 + 状态 + 「查看过程」入口。
 * - running：图标 Spin 脉冲着色 + 左侧主题色呼吸条（agc-pulse，全局动画）
 * - done/fail：静态状态字；摘要可点击展开（run 号 + 结果摘要）
 * - 取消按钮改常驻头行小链接（原底部独立条带退役，一行高度收口）
 * runId=持久 r-{seq}（agent_run 审计行关联；展开体标注 run 号）。
 * D26-O6：subagent-card/delegate-card 输入行类退役——内联 token + antd Input/Spin。
 */

import { memo, useState } from 'react';
import { Spin, Typography, theme } from 'antd';
import { ChevronRight, Radar } from 'lucide-react';
import { useAgentStore } from '../store/agent';
import type { StreamItem } from '../store/agent';

type SubagentItem = Extract<StreamItem, { kind: 'subagent' }>;

export const SubagentCard = memo(function SubagentCard({ item }: { item: SubagentItem }) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const cancelRun = useAgentStore((st) => st.cancelRun);
  const openRunTab = useAgentStore((st) => st.openRunTab);

  const running = item.status === 'running';

  const statusNode =
    running ? (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Spin size="small" aria-hidden />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          探查中
        </Typography.Text>
      </span>
    ) : item.status === 'done' ? (
      <Typography.Text type="success" style={{ fontSize: 12 }}>
        完成
      </Typography.Text>
    ) : (
      <Typography.Text type="danger" style={{ fontSize: 12 }}>
        失败
      </Typography.Text>
    );

  return (
    <div style={{ alignSelf: 'stretch', minWidth: 0, display: 'flex', alignItems: 'stretch', gap: 6 }}>
      {/* 运行中左侧主题色呼吸条（agc-pulse 全局动画；落定退场） */}
      {running ? (
        <span
          aria-hidden
          style={{ width: 2, borderRadius: 999, flexShrink: 0, background: token.colorPrimary, animation: 'agc-pulse 0.9s steps(2) infinite' }}
        />
      ) : null}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            title={open ? '收起' : '展开摘要'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flex: 1,
              minWidth: 0,
              padding: 0,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 12,
              textAlign: 'left',
              height: 'auto',
            }}
          >
            <ChevronRight
              size={12}
              aria-hidden
              style={{ color: token.colorTextQuaternary, flexShrink: 0, transition: 'transform 0.15s ease', transform: open ? 'rotate(90deg)' : undefined }}
            />
            {/* 子任务图标：主题色（六套 accent 切换即随变；显眼+呼吸脉冲） */}
            <Radar
              size={14}
              aria-hidden
              strokeWidth={2.5}
              style={{ flexShrink: 0, color: token.colorPrimary, animation: running ? 'agc-pulse 0.9s steps(2) infinite' : undefined }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
              子任务
            </Typography.Text>
            <Typography.Text ellipsis style={{ minWidth: 0, fontSize: 12, color: token.colorTextSecondary }}>
              {item.taskDigest}
            </Typography.Text>
          </button>
          <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{statusNode}</span>
          {/* D33：查看过程 → 右栏内容坞（会话归属=本卡所在主会话；点击才建 tab） */}
          <Typography.Link
            style={{ fontSize: 12, paddingInline: 8, flexShrink: 0 }}
            onClick={() => openRunTab(item.sessionId, item.runId, item.taskDigest)}
          >
            查看过程
          </Typography.Link>
          {running ? (
            <Typography.Link
              type="danger"
              style={{ fontSize: 12, paddingInline: 4, flexShrink: 0 }}
              onClick={() => cancelRun(item.runId)}
            >
              取消
            </Typography.Link>
          ) : null}
        </div>
        {open ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0 2px 24px', minWidth: 0 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              run {item.runId}
            </Typography.Text>
            <div
              style={{
                fontFamily: 'var(--bbc-font-mono)',
                fontSize: 12,
                background: token.colorFillQuaternary,
                borderRadius: 4,
                padding: '6px 10px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: 220,
                overflowY: 'auto',
                color: token.colorTextSecondary,
              }}
            >
              {item.summary ?? '（执行中…）'}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});
