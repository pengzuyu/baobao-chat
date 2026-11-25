/**
 * 审批 · 命令确认（PAG-04 §3.4.1 / INT-AG-03/20；审批卡状态机 §4.2）：
 * 2026-11-18 用户口径——审批不再独立开框，内嵌到本来的工具卡（ToolBlock）
 * 展示（Runtime 时序：toolCall 先落流，permissionRequest 后到且
 * requestId="pr-{callId}" 可精确配对）。本文件提供：
 * - PermissionControls：控件核心（命令可编辑/判定说明/粒度三选/允许拒绝），
 *   工具卡内嵌与兜底卡共用；审批不超时（2026-11-25 拍板：不会发生过期，
 *   原 120s 倒计时/超时置灰随超时机制整链退役）
 * - permissionSettledText：终态文案（工具卡头行/展开体终态行共用）
 * - PermissionCard：配对失败兜底独立卡（时序异常防御；正常路径不渲染）
 * D26-O6：内联 token + antd Tag/Segmented/Input/Typography。
 */

import { memo, useState } from 'react';
import { Input, Segmented, Tag, Typography, theme } from 'antd';
import { ShieldAlert } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import type { StreamItem } from '../store/agent';
import { RISK_LABELS } from '../bridge/types';
import type { GrantScope } from '../bridge/types';

export type PermissionItem = Extract<StreamItem, { kind: 'permission' }>;

const SCOPE_OPTIONS: Array<{ value: GrantScope; label: string; desc: string }> = [
  { value: 'once', label: '仅本次', desc: '只放行这一次调用' },
  { value: 'session', label: '本会话', desc: '本会话内同类操作不再询问' },
  { value: 'permanent', label: '永久', desc: '写入 allow.json，长期生效' },
];

export interface PermissionDecision {
  requestId: string;
  decision: 'allow' | 'deny';
  scope: GrantScope;
  editedArgs?: Record<string, unknown>;
}

export function scopeLabel(s?: GrantScope): string {
  return SCOPE_OPTIONS.find((o) => o.value === s)?.label ?? '';
}

/** 审批终态文案（工具卡头行状态/展开体终态行共用；null=仍在等待） */
export function permissionSettledText(item: PermissionItem): { text: string; tone: 'ok' | 'dim' } | null {
  const { outcome } = item;
  if (outcome === null) return null;
  if (outcome.decision === 'cancelled') return { text: '审批已作废（会话暂停/紧急停止）', tone: 'dim' };
  if (outcome.decision === 'deny') return { text: '拒绝执行', tone: 'dim' };
  return { text: `审批通过 · ${scopeLabel(outcome.scope)}`, tone: 'ok' };
}

/** 允许且用户改过命令 → 实际执行的命令（原命令=审批 preview；null=未改/非 allow） */
export function permissionEditedCommand(item: PermissionItem): string | null {
  const { outcome } = item;
  if (!outcome || outcome.decision !== 'allow') return null;
  const edited = outcome.editedArgs?.command;
  const original = item.request.preview.kind === 'command' ? item.request.preview.command : undefined;
  if (typeof edited !== 'string' || !edited || edited === original) return null;
  return edited;
}

/** 审批终态详情（状态行 + 改过命令时的「原命令 → 实际执行」对比）——
 *  工具卡展开体与兜底卡共用；落定后回看：是否通过、按什么粒度、实际执行了什么 */
export const PermissionSettled = memo(function PermissionSettled({ item }: { item: PermissionItem }) {
  const settled = permissionSettledText(item);
  if (!settled) return null;
  const edited = permissionEditedCommand(item);
  const original = item.request.preview.kind === 'command' ? item.request.preview.command : undefined;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Typography.Text type={settled.tone === 'ok' ? 'success' : 'secondary'} style={{ fontSize: 12 }}>
        {settled.text}
      </Typography.Text>
      {edited && original ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ fontFamily: 'var(--bbc-font-mono)', fontSize: 12, color: 'inherit', opacity: 0.72, textDecoration: 'line-through', wordBreak: 'break-all' }}>
            $ {original}
          </div>
          <div style={{ fontFamily: 'var(--bbc-font-mono)', fontSize: 12, wordBreak: 'break-all' }}>
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              改后执行：
            </Typography.Text>
            $ {edited}
          </div>
        </div>
      ) : null}
    </div>
  );
});

/** 风险等级 → antd Tag 色（原 agent-risk--low/mid/high：绿/橙/红） */
function riskTagColor(risk: string): 'success' | 'warning' | 'error' {
  if (risk === 'low') return 'success';
  if (risk === 'mid') return 'warning';
  return 'error';
}

/** 审批控件核心（等待中渲染）：工作目录 + 命令（可编辑）+ 判定说明 +
 *  粒度三选 + 允许/拒绝（不超时——等用户处理或中断） */
export const PermissionControls = memo(function PermissionControls({
  item,
  onRespond,
}: {
  item: PermissionItem;
  onRespond: (d: PermissionDecision) => void;
}) {
  const { request, outcome } = item;
  const waiting = outcome === null;
  const commandPreview = request.preview.kind === 'command' ? request.preview : null;

  // 命令可编辑（INT-AG-20：编辑不改变风险重判，Runtime 重走判定）
  const [editedCommand, setEditedCommand] = useState<string | null>(null);
  const [scope, setScope] = useState<GrantScope>('once');

  const doAllow = () => {
    if (!waiting) return;
    const editedArgs =
      commandPreview && editedCommand !== null && editedCommand !== commandPreview.command
        ? { command: editedCommand, cwd: commandPreview.cwd }
        : undefined;
    onRespond({ requestId: request.requestId, decision: 'allow', scope, editedArgs });
  };
  const doDeny = () => {
    if (!waiting) return;
    onRespond({ requestId: request.requestId, decision: 'deny', scope });
  };

  if (!waiting) {
    return <PermissionSettled item={item} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
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
                （可编辑，改后按新命令执行；不会超时）
              </Typography.Text>
            </Typography.Text>
            <Input
              value={editedCommand ?? commandPreview.command}
              onChange={(e) => setEditedCommand(e.target.value)}
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

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <Button onClick={doAllow}>允许</Button>
        <Button variant="secondary" onClick={doDeny}>
          拒绝
        </Button>
      </div>
    </div>
  );
});

/** 兜底独立卡（renderStreamItems 配对失败时才渲染：时序异常防御） */
export const PermissionCard = memo(function PermissionCard({
  item,
  onRespond,
}: {
  item: PermissionItem;
  onRespond: (d: PermissionDecision) => void;
}) {
  const { token } = theme.useToken();
  const { request, outcome } = item;
  const waiting = outcome === null;
  const approved = !!outcome && outcome.decision === 'allow';
  const headBandBg = waiting ? token.colorWarningBg : approved ? token.colorSuccessBg : token.colorFillQuaternary;

  return (
    <div
      data-request-id={request.requestId}
      style={{
        alignSelf: 'stretch',
        border: `1px solid ${waiting ? token.colorWarning : approved ? token.colorSuccess : token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        background: token.colorBgContainer,
        overflow: 'hidden',
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
      </div>
      <div style={{ padding: 12 }}>
        <PermissionControls item={item} onRespond={onRespond} />
      </div>
    </div>
  );
});
