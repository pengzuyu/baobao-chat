/**
 * 工具调用行（PAG-03 §3.3 / INT-AG-02；2026-11-14 全页过程流口径：一行一项）：
 * - 头部：图标 + 中文类型标签（title 提示原始工具名）+ 关键参数（终端=命令原文）+
 *   风险徽标 + 状态（运行中 Spin / ok+耗时 / failed / blocked 红条带错误码）
 * - 收起态追加结果摘要预览行（ZCode 式一行预览，展开后由完整区块替代）
 * - 展开体：输入参数摘要（脱敏后的 args）+ 结果摘要（≤10 行）
 * - D26-O6：tool-card/agent-risk 类退役——内联 token 容器 + antd Tag/Spin/Typography；
 *   运行中自动展开/落定折叠行为原样保留。
 */

import { memo, useEffect, useState, type CSSProperties } from 'react';
import { Spin, Tag, Typography, theme } from 'antd';
import { ChevronRight, FileText, Search, Terminal, Wrench } from 'lucide-react';
import { toolCallCommand } from '../../../shared/components/AgentProcessCard';
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

/** 工具名 → 中文类型标签（2026-11-14 全页过程流口径；头部 title 提示原名） */
function toolLabel(tool: string): string {
  if (tool === 'run_command') return '终端';
  if (tool.startsWith('read')) return '读取文件';
  if (tool.startsWith('edit') || tool.startsWith('write')) return '编辑文件';
  if (tool.startsWith('glob') || tool.startsWith('grep') || tool.startsWith('search')) return '搜索';
  if (tool.startsWith('fetch') || tool.startsWith('web')) return '网页';
  if (tool === 'ask_user') return '提问';
  return tool;
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

/** 风险等级 → antd Tag 色（原 agent-risk--low/mid/high 语义：绿/橙/红） */
function riskTagColor(risk: string): 'success' | 'warning' | 'error' {
  if (risk === 'low') return 'success';
  if (risk === 'mid') return 'warning';
  return 'error';
}

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

/** 头部折叠行样式（工具卡/子任务卡/委派卡共用口径，各文件内联） */
const headToggleStyle: CSSProperties = {
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
};

/** 等宽内容块样式（参数/结果/日志；底色 token 取代原硬编码 rgba——对齐 agent-md 行内码观感） */
function monoBlockStyle(token: ReturnType<typeof theme.useToken>['token']): CSSProperties {
  return {
    fontFamily: 'var(--bbw-font-mono)',
    fontSize: 12,
    background: token.colorFillSecondary,
    borderRadius: 4,
    padding: '8px 12px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxHeight: 220,
    overflowY: 'auto',
    margin: 0,
  };
}

export const ToolCard = memo(function ToolCard({ item }: { item: ToolItem }) {
  const { token } = theme.useToken();
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
  // 2026-11-12 终端行口径：run_command 头部显示「终端」+命令（单行截断），
  // 与 IM 落流卡 ToolRow 同款（toolCallCommand 共用）；其他工具显示关键参数
  const isTerm = call.tool === 'run_command';
  const cmd = toolCallCommand(call.tool, call.args);

  const statusNode = running ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <Spin size="small" aria-hidden />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        运行中
      </Typography.Text>
    </span>
  ) : result?.ok ? (
    <Typography.Text type="success" style={{ fontSize: 12 }}>
      ok · {formatDuration(result.durationMs)}{result.exitCode !== undefined ? ` · exit ${result.exitCode}` : ''}
    </Typography.Text>
  ) : blocked ? (
    <Typography.Text type="danger" style={{ fontSize: 12 }}>
      被阻止 · {BLOCK_LABELS[blocked.code] ?? `错误码 ${blocked.code}`}
    </Typography.Text>
  ) : (
    <Typography.Text type="danger" style={{ fontSize: 12 }}>
      失败{result?.exitCode !== undefined ? ` · exit ${result.exitCode}` : ''}
    </Typography.Text>
  );

  return (
    <div
      style={{
        alignSelf: 'stretch',
        border: `1px solid ${blocked ? token.colorError : token.colorBorderSecondary}`,
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
        <Icon size={13} aria-hidden style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
        <Typography.Text style={{ fontFamily: 'var(--bbw-font-mono)', fontSize: 12, flexShrink: 0 }} title={call.tool}>
          {toolLabel(call.tool)}
        </Typography.Text>
        {cmd ? (
          <Typography.Text code copyable={false} style={{ fontSize: 12, minWidth: 0, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: 'transparent', border: 'none', padding: 0 }}>
            {cmd}
          </Typography.Text>
        ) : null}
        <Tag color={riskTagColor(call.risk)} style={{ fontSize: 10, lineHeight: '16px', paddingInline: 5, marginInlineEnd: 0, flexShrink: 0 }}>
          {RISK_LABELS[call.risk]}
        </Tag>
        <span style={{ marginLeft: 'auto', minWidth: 0, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{statusNode}</span>
      </button>
      {/* blocked 红条带（错误码 + 规则名；时间线红标同源，D08 §5.2） */}
      {blocked ? (
        <div style={{ background: token.colorErrorBg, color: token.colorError, fontSize: 12, padding: '3px 12px', borderTop: `1px solid ${token.colorError}` }}>
          {blocked.code} · {BLOCK_LABELS[blocked.code] ?? '已拦截'} · {blocked.rule}
        </div>
      ) : null}
      {/* 收起态结果摘要预览行（ZCode 式一行预览；展开后由完整结果区块替代。
          paddingLeft 53 对齐头部图标后文本起点：12(容器) + 12(箭头) + 8 + 13(图标) + 8 */}
      {!open && result?.ok && result.summary ? (
        <div
          style={{ padding: '0 12px 8px 53px', fontSize: 12, lineHeight: 1.5, color: token.colorTextTertiary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          title={result.summary}
        >
          {result.summary}
        </div>
      ) : null}
      {open ? (
        <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              {isTerm ? '命令' : '输入参数（已脱敏）'}
            </Typography.Text>
            <div style={monoBlockStyle(token)}>{isTerm && cmd ? `$ ${cmd}` : summarizeArgs(call.args) || '（无参数）'}</div>
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              执行结果{result?.truncated ? '（已截断）' : ''}
            </Typography.Text>
            <div style={monoBlockStyle(token)}>{result?.summary ?? '（执行中…）'}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
});
