/**
 * 子 Agent 卡（D16 类型 1 / P0-4）：并行探查任务行——
 * spawn → running（Spin）→ done/fail（摘要可展开）。
 * runId=持久 r-{seq}（agent_run 审计行关联；展开体标注 run 号）。
 * D26-O6：subagent-card/delegate-card 输入行类退役——内联 token + antd Input/Spin。
 */

import { memo, useState } from 'react';
import { Input, Spin, Typography, theme } from 'antd';
import { useImeGuard } from '../../../shared/hooks/useImeGuard';
import { ChevronRight, Radar } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { useAgentStore } from '../store/agent';
import type { StreamItem } from '../store/agent';

type SubagentItem = Extract<StreamItem, { kind: 'subagent' }>;

/** 过程卡头部折叠行（原 tool-card__head 口径，内联） */
const headToggleStyle = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 13,
  textAlign: 'left',
  height: 'auto',
} as const;

export const SubagentCard = memo(function SubagentCard({ item }: { item: SubagentItem }) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const sendRunInput = useAgentStore((st) => st.sendRunInput);
  const cancelRun = useAgentStore((st) => st.cancelRun);
  const { imeComposing, imeCompositionProps } = useImeGuard();
  const [draft, setDraft] = useState('');

  const statusNode =
    item.status === 'running' ? (
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
    <div
      style={{
        alignSelf: 'stretch',
        border: `1px solid ${item.status === 'failed' ? token.colorError : token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        background: token.colorBgContainer,
        overflow: 'hidden',
      }}
    >
      <button type="button" style={headToggleStyle} onClick={() => setOpen((v) => !v)}>
        <ChevronRight
          size={12}
          aria-hidden
          style={{ color: token.colorTextQuaternary, flexShrink: 0, transition: 'transform 0.15s ease', transform: open ? 'rotate(90deg)' : undefined }}
        />
        <Radar size={13} aria-hidden style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
        <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
          子任务
        </Typography.Text>
        <Typography.Text ellipsis style={{ minWidth: 0, fontSize: 12 }}>
          {item.taskDigest}
        </Typography.Text>
        <span style={{ marginLeft: 'auto', minWidth: 0, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{statusNode}</span>
      </button>
      {item.status === 'running' ? (
        <div
          style={{
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input
              size="small"
              value={draft}
              placeholder="运行中补充指令（下一轮生效）…"
              style={{ flex: 1, minWidth: 0, fontSize: 12 }}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !imeComposing()) {
                  sendRunInput(item.runId, draft);
                  setDraft('');
                }
              }}
              {...imeCompositionProps}
            />
            <Button
              variant="secondary"
              size="small"
              disabled={!draft.trim()}
              onClick={() => {
                sendRunInput(item.runId, draft);
                setDraft('');
              }}
            >
              下发
            </Button>
            <Button variant="secondary" size="small" onClick={() => cancelRun(item.runId)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}
      {open ? (
        <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              run {item.runId}
            </Typography.Text>
            <div
              style={{
                fontFamily: 'var(--bbw-font-mono)',
                fontSize: 12,
                background: 'rgba(127, 134, 145, 0.14)',
                borderRadius: 4,
                padding: '8px 12px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: 220,
                overflowY: 'auto',
              }}
            >
              {item.summary ?? '（执行中…）'}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});
