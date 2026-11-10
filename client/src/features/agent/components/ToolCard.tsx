/**
 * 工具调用折叠卡（PAG-03 §3.3 / INT-AG-02）：
 * - 头部：图标 + 工具名 + 风险徽标 + 状态（运行中 spinner / ok+耗时 / failed / blocked 红条带错误码）
 * - 展开体：输入参数摘要（脱敏后的 args）+ 结果摘要（≤10 行）
 */

import { useEffect, useState } from 'react';
import { ChevronRight, FileText, Loader2, Search, Terminal, Wrench } from 'lucide-react';
import type { StreamItem } from '../store/agent';
import { RISK_LABELS } from '../bridge/types';

type ToolItem = Extract<StreamItem, { kind: 'tool' }>;

/** 工具名 → 头部图标 */
function toolIcon(tool: string) {
  if (tool.startsWith('read') || tool.startsWith('edit') || tool.startsWith('write') || tool.includes('file')) return FileText;
  if (tool.startsWith('run') || tool.includes('command')) return Terminal;
  if (tool.startsWith('search') || tool.startsWith('glob') || tool.startsWith('grep')) return Search;
  return Wrench;
}

/** 8020-8026 拦截码文案（14 篇 §7 错误码映射） */
const BLOCK_LABELS: Record<number, string> = {
  8020: '权限/路径拦截',
  8021: '危险命令规则',
  8022: '资源超限',
  8023: '命令超时',
  8024: '符号链接逃逸',
  8025: '网络出站拦截',
  8026: '敏感文件拒读',
};

function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** 参数摘要：一行一键值（对象值 JSON 压缩，≤80 字符） */
function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      const shown = val && val.length > 80 ? `${val.slice(0, 80)}…` : (val ?? '');
      return `${k}: ${shown}`;
    })
    .join('　');
}

export function ToolCard({ item }: { item: ToolItem }) {
  // D19 自动折叠：运行中展开看实时参数、结果落定自动收回头部行（手动点击仍可翻转；
  // 每次 running 翻转重置回自动态，对齐 change-my-life ToolCallGroup 行为）
  const { call, result } = item;
  const running = !result;
  const [open, setOpen] = useState(running);
  useEffect(() => {
    setOpen(running);
  }, [running]);
  const Icon = toolIcon(call.tool);
  const blocked = result?.blocked;

  const statusNode = running ? (
    <span className="tool-card__status tool-card__status--running">
      <Loader2 size={12} className="bbw-spin" aria-hidden />
      运行中
    </span>
  ) : result?.ok ? (
    <span className="tool-card__status tool-card__status--ok">ok · {formatDuration(result.durationMs)}{result.exitCode !== undefined ? ` · exit ${result.exitCode}` : ''}</span>
  ) : blocked ? (
    <span className="tool-card__status tool-card__status--blocked">被阻止 · {BLOCK_LABELS[blocked.code] ?? `错误码 ${blocked.code}`}</span>
  ) : (
    <span className="tool-card__status tool-card__status--failed">失败{result?.exitCode !== undefined ? ` · exit ${result.exitCode}` : ''}</span>
  );

  return (
    <div className={`tool-card${blocked ? ' tool-card--blocked' : ''}`}>
      <button type="button" className="tool-card__head" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={12} className={`tool-card__chev${open ? ' tool-card__chev--open' : ''}`} aria-hidden />
        <Icon size={13} className="tool-card__icon" aria-hidden />
        <span className="tool-card__name">{call.tool}</span>
        <span className={`agent-risk agent-risk--${call.risk}`}>{RISK_LABELS[call.risk]}</span>
        <span className="tool-card__status-wrap">{statusNode}</span>
      </button>
      {/* blocked 红条带（错误码 + 规则名；时间线红标同源，D08 §5.2） */}
      {blocked ? (
        <div className="tool-card__blocked-band">
          {blocked.code} · {BLOCK_LABELS[blocked.code] ?? '已拦截'} · {blocked.rule}
        </div>
      ) : null}
      {open ? (
        <div className="tool-card__body">
          <div className="tool-card__section">
            <div className="tool-card__section-label">输入参数（已脱敏）</div>
            <div className="tool-card__mono">{summarizeArgs(call.args) || '（无参数）'}</div>
          </div>
          <div className="tool-card__section">
            <div className="tool-card__section-label">结果摘要{result?.truncated ? '（已截断）' : ''}</div>
            <div className="tool-card__mono">{result?.summary ?? '（执行中…）'}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
