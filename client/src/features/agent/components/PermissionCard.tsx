/**
 * 审批卡 · 命令确认形态（PAG-04 §3.4.1 / INT-AG-03/20；审批卡状态机 §4.2）：
 * - 工具名 + 风险 + 参数预览（命令文本框可编辑，允许时回传 editedArgs）
 * - 记忆粒度三选（antd Segmented）：本次 / 本会话 / 永久（高危不出现永久，options 由 Runtime 下发）
 * - [允许] [拒绝]；120s 倒计时进度条，到点自动置灰 = 已超时拒绝
 * - 终态折叠：已允许（含粒度）/ 已拒绝 / 已超时 / 已作废（紧急停止）
 * D26-O6：perm-card/perm-scope 类退役——内联 token + antd Tag/Segmented/Input/Typography。
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { Input, Segmented, Tag, Typography, theme } from 'antd';
import { ShieldAlert } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import type { StreamItem } from '../store/agent';
import { RISK_LABELS } from '../bridge/types';
import type { GrantScope } from '../bridge/types';

type PermissionItem = Extract<StreamItem, { kind: 'permission' }>;

const SCOPE_OPTIONS: Array<{ value: GrantScope; label: string; desc: string }> = [
  { value: 'once', label: '仅本次', desc: '只放行这一次调用' },
  { value: 'session', label: '本会话', desc: '本会话内同类操作不再询问' },
  { value: 'permanent', label: '永久', desc: '写入 allow.json，长期生效' },
];

const PERMISSION_WINDOW_MS = 120_000;

export interface PermissionDecision {
  requestId: string;
  decision: 'allow' | 'deny';
  scope: GrantScope;
  editedArgs?: Record<string, unknown>;
}

interface PermissionCardProps {
  item: PermissionItem;
  onRespond: (d: PermissionDecision) => void;
}

/** 风险等级 → antd Tag 色（原 agent-risk--low/mid/high：绿/橙/红） */
function riskTagColor(risk: string): 'success' | 'warning' | 'error' {
  if (risk === 'low') return 'success';
  if (risk === 'mid') return 'warning';
  return 'error';
}

export const PermissionCard = memo(function PermissionCard({ item, onRespond }: PermissionCardProps) {
  const { token } = theme.useToken();
  const { request, outcome } = item;
  const waiting = outcome === null;
  const commandPreview = request.preview.kind === 'command' ? request.preview : null;

  // 命令可编辑（INT-AG-20：编辑不改变风险重判，Runtime 重走判定）
  const [editedCommand, setEditedCommand] = useState<string | null>(null);
  const [scope, setScope] = useState<GrantScope>('once');
  const [now, setNow] = useState(() => Date.now());

  // 倒计时：等待中每秒推进（到点由 store 计时器置 timeout；此处同步展示）
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);

  const remainingMs = useMemo(() => Math.max(0, request.expiresAt - now), [request.expiresAt, now]);
  const remainingSec = Math.ceil(remainingMs / 1000);
  const progress = Math.min(100, Math.max(0, (remainingMs / PERMISSION_WINDOW_MS) * 100));
  const expired = waiting && remainingMs <= 0;
  const approved = !!outcome && outcome !== 'timeout' && outcome.decision === 'allow';
  const timeoutLook = expired || outcome === 'timeout';

  const doAllow = () => {
    if (!waiting || expired) return;
    const editedArgs =
      commandPreview && editedCommand !== null && editedCommand !== commandPreview.command
        ? { command: editedCommand, cwd: commandPreview.cwd }
        : undefined;
    onRespond({ requestId: request.requestId, decision: 'allow', scope, editedArgs });
  };
  const doDeny = () => {
    if (!waiting || expired) return;
    onRespond({ requestId: request.requestId, decision: 'deny', scope });
  };

  const scopeLabel = (s?: GrantScope): string => SCOPE_OPTIONS.find((o) => o.value === s)?.label ?? '';

  /** 终态文案（先窄化再取值，避免联合类型上的属性访问） */
  const outcomeInfo = (): { text: string; dim: boolean } => {
    if (outcome === 'timeout' || (outcome === null && expired)) return { text: '已超时（视为拒绝）', dim: true };
    if (outcome === null) return { text: '等待决策', dim: true };
    if (outcome.decision === 'cancelled') return { text: '已作废（会话暂停/紧急停止）', dim: true };
    if (outcome.decision === 'deny') return { text: '已拒绝', dim: true };
    const editedNote = commandPreview && editedCommand !== null && editedCommand !== commandPreview.command ? ' · 已改命令' : '';
    return { text: `已允许 · ${scopeLabel(outcome.scope)}${editedNote}`, dim: false };
  };
  const settled = outcomeInfo();

  // 头带底色口径：等待=警示黄、已允许=成功绿、终态=中性
  const headBandBg = waiting && !expired ? token.colorWarningBg : approved ? token.colorSuccessBg : token.colorFillQuaternary;

  return (
    <div
      data-request-id={request.requestId}
      style={{
        alignSelf: 'stretch',
        border: `1px solid ${waiting && !expired ? token.colorWarning : approved ? token.colorSuccess : token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        background: token.colorBgContainer,
        boxShadow: waiting && !expired ? token.boxShadowTertiary : 'none',
        overflow: 'hidden',
        opacity: timeoutLook ? 0.72 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: headBandBg }}>
        <ShieldAlert size={14} aria-hidden style={{ color: token.colorWarning, flexShrink: 0 }} />
        <Typography.Text strong style={{ fontSize: 13, flexShrink: 0 }}>
          命令执行请求
        </Typography.Text>
        <Tag color={riskTagColor(request.risk)} style={{ fontSize: 10, lineHeight: '16px', paddingInline: 5, marginInlineEnd: 0, flexShrink: 0 }}>
          {RISK_LABELS[request.risk]}
        </Tag>
        <Typography.Text code copyable={false} style={{ fontSize: 12, background: 'transparent', border: 'none', padding: 0, flexShrink: 0 }}>
          {request.tool}
        </Typography.Text>
        {waiting ? (
          <Typography.Text type="warning" style={{ marginLeft: 'auto', fontSize: 12, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            剩余 {remainingSec}s
          </Typography.Text>
        ) : null}
      </div>

      {/* 120s 倒计时进度条（到点自动置灰=拒绝，D08 §3.4） */}
      {waiting ? (
        <div style={{ height: 3, background: token.colorBorderSecondary }}>
          <div style={{ height: '100%', width: `${progress}%`, background: token.colorWarning, transition: 'width 1s linear' }} />
        </div>
      ) : null}

      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {commandPreview ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
              <Typography.Text type="secondary" style={{ flexShrink: 0, minWidth: 60 }}>
                工作目录
              </Typography.Text>
              <Typography.Text style={{ fontFamily: 'var(--bbc-font-mono)', fontSize: 12, wordBreak: 'break-all', minWidth: 0 }}>
                {commandPreview.cwd}（白名单内 ✓）
              </Typography.Text>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
              <Typography.Text type="secondary" style={{ flexShrink: 0 }}>
                命令
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  （可编辑，改后按新命令执行）
                </Typography.Text>
              </Typography.Text>
              <Input
                value={editedCommand ?? commandPreview.command}
                onChange={(e) => setEditedCommand(e.target.value)}
                readOnly={!waiting || expired}
                spellCheck={false}
                aria-label="待执行命令（可编辑）"
                style={{ fontFamily: 'var(--bbc-font-mono)', fontSize: 13 }}
              />
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
            <Typography.Text type="secondary" style={{ flexShrink: 0, minWidth: 60 }}>
              参数预览
            </Typography.Text>
            <Typography.Text style={{ fontFamily: 'var(--bbc-font-mono)', fontSize: 12, wordBreak: 'break-all', minWidth: 0 }}>
              {request.preview.kind}（该形态的预览渲染后续版本接入）
            </Typography.Text>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
          <Typography.Text type="secondary" style={{ flexShrink: 0, minWidth: 60 }}>
            判定说明
          </Typography.Text>
          <Typography.Text style={{ minWidth: 0 }}>{request.reason}</Typography.Text>
        </div>

        {/* 记忆粒度三选（antd Segmented radiogroup；高危 options 不含 permanent；D08 §3.4/09 §4.2） */}
        {waiting && !expired ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            <Segmented<GrantScope>
              size="small"
              aria-label="记忆粒度"
              value={scope}
              onChange={(v) => setScope(v)}
              options={SCOPE_OPTIONS.filter((o) => request.options.includes(o.value)).map((o) => ({
                value: o.value,
                label: <span title={o.desc}>{o.label}</span>,
              }))}
            />
            {!request.options.includes('permanent') ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                高危工具不提供永久记忆
              </Typography.Text>
            ) : null}
          </div>
        ) : null}

        {waiting && !expired ? (
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <Button onClick={doAllow}>允许</Button>
            <Button variant="secondary" onClick={doDeny}>
              拒绝
            </Button>
          </div>
        ) : (
          <Typography.Text
            type={settled.dim ? 'secondary' : 'success'}
            style={{ fontSize: 13, alignSelf: 'flex-start', padding: '2px 8px', borderRadius: token.borderRadiusSM }}
          >
            {settled.text}
          </Typography.Text>
        )}
      </div>
    </div>
  );
});
