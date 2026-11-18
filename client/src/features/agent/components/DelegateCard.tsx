/**
 * 委派卡（D16 类型 3 / P0-4）：四相位状态机——
 * - brief：简报待确认（建议后端 + [确认启动] [取消]；不改稿是主路径，编辑稿随 P1）
 * - running：后台执行中（输出尾窗 ≤50 行 + [取消]；会话可继续对话）
 * - review：delegate.end（exit=0）驱动——摘要/改动文件/续接句柄 + [采纳并回填] [拒绝]
 * - resolved：终态（已采纳/已拒绝/失败/已取消）
 * D26-O6：delegate-card 类退役——内联 token + antd Input/Spin/Typography。
 */

import { memo, useState } from 'react';
import { Spin, Typography, theme } from 'antd';
import { CheckCircle2, ChevronRight, TerminalSquare, XCircle } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { useAgentStore } from '../store/agent';
import type { StreamItem } from '../store/agent';

type DelegateItem = Extract<StreamItem, { kind: 'delegate' }>;

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

/** 等宽内容块（原 tool-card__mono） */
const monoBlockStyle = {
  fontFamily: 'var(--bbc-font-mono)',
  fontSize: 12,
  background: 'rgba(127, 134, 145, 0.14)',
  borderRadius: 4,
  padding: '8px 12px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  overflowY: 'auto',
} as const;

export const DelegateCard = memo(function DelegateCard({ item }: { item: DelegateItem }) {
  const { token } = theme.useToken();
  const confirmDelegate = useAgentStore((st) => st.confirmDelegate);
  const reviewDelegate = useAgentStore((st) => st.reviewDelegate);
  const cancelDelegate = useAgentStore((st) => st.cancelDelegate);
  const openRunView = useAgentStore((st) => st.openRunView);
  const [open, setOpen] = useState(false);

  const failed = item.end !== undefined && item.end.exitCode !== 0;

  const headStatus =
    item.phase === 'brief' ? (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        待确认
      </Typography.Text>
    ) : item.phase === 'running' ? (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Spin size="small" aria-hidden />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          后台执行中
        </Typography.Text>
      </span>
    ) : item.phase === 'review' ? (
      <Typography.Text type="warning" style={{ fontSize: 12 }}>
        待审查
      </Typography.Text>
    ) : failed ? (
      <Typography.Text type="danger" style={{ fontSize: 12 }}>
        失败 · exit {item.end?.exitCode}
      </Typography.Text>
    ) : item.decision === 'accept' ? (
      <Typography.Text type="success" style={{ fontSize: 12 }}>
        已采纳
      </Typography.Text>
    ) : (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {item.decision === 'reject' ? '已拒绝' : '已取消'}
      </Typography.Text>
    );

  return (
    <div
      style={{
        alignSelf: 'stretch',
        border: `1px solid ${failed ? token.colorError : token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        background: token.colorBgContainer,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button type="button" style={{ ...headToggleStyle, flex: 1, minWidth: 0 }} onClick={() => setOpen((v) => !v)}>
          <ChevronRight
            size={12}
            aria-hidden
            style={{ color: token.colorTextQuaternary, flexShrink: 0, transition: 'transform 0.15s ease', transform: open ? 'rotate(90deg)' : undefined }}
          />
          <TerminalSquare size={13} aria-hidden style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
          <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
            委派
          </Typography.Text>
          <Typography.Text code copyable={false} style={{ fontSize: 12, background: 'transparent', border: 'none', padding: 0, flexShrink: 0 }}>
            {item.backend || '后端待定'}
          </Typography.Text>
          <span style={{ marginLeft: 'auto', minWidth: 0, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{headStatus}</span>
        </button>
        {/* D33：查看过程 → 右栏运行详情（childSessionRef 会话历史优先） */}
        <Typography.Link
          style={{ fontSize: 12, padding: '0 12px', flexShrink: 0 }}
          onClick={(e) => {
            e.stopPropagation();
            openRunView(item.runId);
          }}
        >
          查看过程
        </Typography.Link>
      </div>

      {item.phase === 'brief' ? (
        <div
          style={{
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Agent 请求委派本机编码智能体执行任务，确认后转后台运行（简报沿用模型产出）
          </Typography.Text>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => confirmDelegate(item.runId, item.backend)}>
              确认启动（{item.backend || '默认后端'}）
            </Button>
            <Button variant="secondary" onClick={() => cancelDelegate(item.runId)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}

      {item.phase === 'running' ? (
        <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, padding: 12, display: 'flex', justifyContent: 'flex-end' }}>
          {/* 补充指令输入框已随「运行中补充指令」退役（stdin 死锁根因，2026-11-18） */}
          <Button variant="secondary" size="small" onClick={() => cancelDelegate(item.runId)}>
            取消委派
          </Button>
        </div>
      ) : null}

      {item.phase === 'review' && item.end ? (
        <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              执行摘要
            </Typography.Text>
            <div style={monoBlockStyle}>{item.end.summary || '（无摘要）'}</div>
          </div>
          {item.end.changedFiles.length > 0 ? (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                改动文件（{item.end.changedFiles.length}）
              </Typography.Text>
              <div style={{ ...monoBlockStyle, maxHeight: 160, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {item.end.changedFiles.map((f) => (
                  <div key={f}>{f}</div>
                ))}
              </div>
            </div>
          ) : null}
          {item.end.childSessionRef && (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, color: token.colorTextSecondary, fontFamily: 'var(--bbc-font-mono)' }}>
              {item.end.childSessionRef ? <span>可续接 {item.end.childSessionRef}</span> : null}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => reviewDelegate(item.runId, true)}>采纳并回填</Button>
            <Button variant="secondary" onClick={() => reviewDelegate(item.runId, false)}>
              拒绝
            </Button>
          </div>
        </div>
      ) : null}

      {item.phase === 'resolved' ? (
        <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {item.decision === 'accept' ? (
            <Typography.Text type="success" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <CheckCircle2 size={12} aria-hidden />
              结果已回填主对话
            </Typography.Text>
          ) : failed ? (
            <Typography.Text type="danger" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <XCircle size={12} aria-hidden />
              {item.end?.summary || '委派异常退出'}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <XCircle size={12} aria-hidden />
              {item.decision === 'reject' ? '结果已拒绝' : '已取消'}
            </Typography.Text>
          )}
        </div>
      ) : null}

      {open && item.logs.length > 0 ? (
        <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              后端输出（尾部 {item.logs.length} 行 · run {item.runId}）
            </Typography.Text>
            <div style={{ ...monoBlockStyle, maxHeight: 220, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {item.logs.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});
