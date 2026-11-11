/**
 * 审批卡 · 命令确认形态（PAG-04 §3.4.1 / INT-AG-03/20；审批卡状态机 §4.2）：
 * - 工具名 + 风险 + 参数预览（命令文本框可编辑，允许时回传 editedArgs）
 * - 记忆粒度三选：本次 / 本会话 / 永久（高危不出现永久，options 由 Runtime 下发）
 * - [允许] [拒绝]；120s 倒计时进度条，到点自动置灰 = 已超时拒绝
 * - 终态折叠：已允许（含粒度）/ 已拒绝 / 已超时 / 已作废（紧急停止）
 */

import { memo, useEffect, useMemo, useState } from 'react';
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

export const PermissionCard = memo(function PermissionCard({ item, onRespond }: PermissionCardProps) {
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

  return (
    <div
      className={`perm-card${waiting ? '' : ' perm-card--settled'}${expired || outcome === 'timeout' ? ' perm-card--timeout' : ''}${
        outcome && outcome !== 'timeout' && outcome.decision === 'allow' ? ' perm-card--approved' : ''
      }`}
      data-request-id={request.requestId}
    >
      <div className="perm-card__head">
        <ShieldAlert size={14} className="perm-card__icon" aria-hidden />
        <span className="perm-card__title">命令执行请求</span>
        <span className={`agent-risk agent-risk--${request.risk}`}>{RISK_LABELS[request.risk]}</span>
        <span className="perm-card__tool">{request.tool}</span>
        {waiting ? <span className="perm-card__countdown">剩余 {remainingSec}s</span> : null}
      </div>

      {/* 120s 倒计时进度条（到点自动置灰=拒绝，D08 §3.4） */}
      {waiting ? <div className="perm-card__timer-track"><div className="perm-card__timer-bar" style={{ width: `${progress}%` }} /></div> : null}

      <div className="perm-card__body">
        {commandPreview ? (
          <>
            <div className="perm-card__row">
              <span className="perm-card__label">工作目录</span>
              <span className="perm-card__value perm-card__value--mono">{commandPreview.cwd}（白名单内 ✓）</span>
            </div>
            <div className="perm-card__row perm-card__row--col">
              <span className="perm-card__label">
                命令<span className="perm-card__label-hint">（可编辑，改后按新命令执行）</span>
              </span>
              <input
                className="perm-card__command"
                value={editedCommand ?? commandPreview.command}
                onChange={(e) => setEditedCommand(e.target.value)}
                readOnly={!waiting || expired}
                spellCheck={false}
                aria-label="待执行命令（可编辑）"
              />
            </div>
          </>
        ) : (
          <div className="perm-card__row">
            <span className="perm-card__label">参数预览</span>
            <span className="perm-card__value perm-card__value--mono">{request.preview.kind}（该形态的预览渲染后续版本接入）</span>
          </div>
        )}
        <div className="perm-card__row">
          <span className="perm-card__label">判定说明</span>
          <span className="perm-card__value">{request.reason}</span>
        </div>

        {/* 记忆粒度三选（高危 options 不含 permanent；D08 §3.4/09 §4.2） */}
        {waiting && !expired ? (
          <div className="perm-card__scopes" role="radiogroup" aria-label="记忆粒度">
            {SCOPE_OPTIONS.filter((o) => request.options.includes(o.value)).map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={scope === o.value}
                className={`perm-scope${scope === o.value ? ' perm-scope--active' : ''}`}
                onClick={() => setScope(o.value)}
                title={o.desc}
              >
                {o.label}
              </button>
            ))}
            {!request.options.includes('permanent') ? <span className="perm-card__scope-note">高危工具不提供永久记忆</span> : null}
          </div>
        ) : null}

        {waiting && !expired ? (
          <div className="perm-card__actions">
            <Button variant="primary" onClick={doAllow}>
              允许
            </Button>
            <Button variant="secondary" onClick={doDeny}>
              拒绝
            </Button>
          </div>
        ) : (
          <div className={`perm-card__outcome${settled.dim ? ' perm-card__outcome--dim' : ''}`}>{settled.text}</div>
        )}
      </div>
    </div>
  );
});
