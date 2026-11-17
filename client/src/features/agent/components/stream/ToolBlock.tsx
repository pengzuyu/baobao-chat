/**
 * 工具块（D33 §3.5 zcode 式平铺流）：左侧状态色条（运行中主色/落定灰/失败红）
 * + 头行（家族图标 + 动作词 + 关键参数单行截断 + 状态/耗时/exit）+ 家族化展开体：
 * - 终端：$ 命令 + 输出块
 * - 编辑：old/new 全量红绿行 diff（精确替换语义，无需 diff 算法）
 * - 写入：行数/字节规模 + 内容预览
 * - 其余：参数摘要 + 结果
 * 行为口径延续 D19：运行中自动展开、结果落定自动收回头行（手动点击可翻转）；
 * blocked 8020-8026 红条带沿用。tool=skill 不达本组件（流分发走 SkillCard）。
 */

import { memo, useEffect, useState, type CSSProperties } from 'react';
import { Spin, Tag, Typography, theme } from 'antd';
import { ChevronRight } from 'lucide-react';
import { RISK_LABELS } from '../../bridge/types';
import type { StreamItem } from '../../store/agent';
import { classifyTool, contentScale, editDiffArgs, splitMcpName, toolHeadParam } from './toolFamilies';

type ToolItem = Extract<StreamItem, { kind: 'tool' }>;

/** 8020-8026 拦截码文案（14 篇 §7；原 ToolCard 表随回合气泡退役迁此） */
const BLOCK_LABELS: Record<number, string> = {
  8020: '权限/路径拦截',
  8021: '危险命令规则',
  8022: '资源超限',
  8023: '命令超时',
  8024: '符号链接逃逸',
  8025: '网络出站拦截',
  8026: '敏感文件拒读',
};

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

const monoBlockStyle: CSSProperties = {
  fontFamily: 'var(--bbc-font-mono)',
  fontSize: 12,
  background: 'rgba(127, 134, 145, 0.14)',
  borderRadius: 4,
  padding: '8px 12px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  maxHeight: 260,
  overflowY: 'auto',
  margin: 0,
};

/** 编辑 diff 行（红删/绿增；精确替换语义=old 全红 new 全绿） */
function DiffBody({ oldText, newText }: { oldText?: string; newText?: string }) {
  const { token } = theme.useToken();
  const row = (prefix: '-' | '+', text: string, bg: string, fg: string) => (
    <div key={`${prefix}-${text}`} style={{ background: bg, color: fg, padding: '1px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
      {prefix} {text}
    </div>
  );
  return (
    <div
      style={{
        fontFamily: 'var(--bbc-font-mono)',
        fontSize: 12,
        lineHeight: 1.6,
        borderRadius: 4,
        overflow: 'hidden',
        border: `1px solid ${token.colorBorderSecondary}`,
        maxHeight: 320,
        overflowY: 'auto',
      }}
    >
      {(oldText ?? '').split('\n').map((l) => row('-', l, token.colorErrorBg, token.colorError))}
      {(newText ?? '').split('\n').map((l) => row('+', l, token.colorSuccessBg, token.colorSuccess))}
      {!oldText && !newText ? <div style={{ padding: '2px 8px', color: token.colorTextTertiary }}>（无差异参数）</div> : null}
    </div>
  );
}

export const ToolBlock = memo(function ToolBlock({ item }: { item: ToolItem }) {
  const { token } = theme.useToken();
  const { call, result } = item;
  const running = !result;
  // D19 自动折叠：运行中展开看实时参数、结果落定自动收回头行
  const [open, setOpen] = useState(running);
  useEffect(() => {
    setOpen(running);
  }, [running]);

  const meta = classifyTool(call.tool);
  const Icon = meta.icon;
  const blocked = result?.blocked;
  const failed = result ? !result.ok : false;
  const param = toolHeadParam(call.tool, call.args);
  const isTerm = meta.family === 'terminal';
  const scale = meta.family === 'fileWrite' ? contentScale(call.args) : null;
  const mcp = meta.family === 'mcp' ? splitMcpName(call.tool) : null;
  const diff = meta.family === 'fileEdit' ? editDiffArgs(call.args) : null;

  const edgeColor = running ? token.colorPrimary : failed || blocked ? token.colorError : token.colorBorderSecondary;

  const statusNode = running ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <Spin size="small" aria-hidden />
    </span>
  ) : result?.ok ? (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {formatDuration(result.durationMs)}
      {result.exitCode !== undefined && result.exitCode !== 0 ? ` · exit ${result.exitCode}` : ''}
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
    <div style={{ alignSelf: 'stretch', borderLeft: `2px solid ${edgeColor}`, paddingLeft: 10, margin: '2px 0' }}>
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
        <Icon size={13} aria-hidden style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
        <Typography.Text style={{ fontSize: 12, flexShrink: 0 }} type="secondary">
          {meta.label}
        </Typography.Text>
        {mcp ? (
          <Tag color="processing" style={{ fontSize: 10, lineHeight: '16px', paddingInline: 5, marginInlineEnd: 0, flexShrink: 0 }}>
            {mcp.server}
          </Tag>
        ) : null}
        {param ? (
          <Typography.Text
            code
            copyable={false}
            style={{ fontSize: 12, minWidth: 0, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: 'transparent', border: 'none', padding: 0 }}
          >
            {param}
          </Typography.Text>
        ) : null}
        {scale ? (
          <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
            · {scale.lines} 行
          </Typography.Text>
        ) : null}
        <span style={{ marginLeft: 'auto', minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {call.risk !== 'low' ? (
            <Tag color={riskTagColor(call.risk)} style={{ fontSize: 10, lineHeight: '16px', paddingInline: 5, marginInlineEnd: 0 }}>
              {RISK_LABELS[call.risk]}
            </Tag>
          ) : null}
          {statusNode}
        </span>
      </button>
      {blocked ? (
        <div style={{ background: token.colorErrorBg, color: token.colorError, fontSize: 12, padding: '2px 8px', borderRadius: 4 }}>
          {blocked.code} · {BLOCK_LABELS[blocked.code] ?? '已拦截'} · {blocked.rule}
        </div>
      ) : null}
      {open ? (
        <div style={{ padding: '6px 0 6px 18px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          {isTerm ? (
            <>
              <pre style={monoBlockStyle}>{`$ ${param ?? ''}`}</pre>
              <pre style={monoBlockStyle}>{result?.summary ?? '（执行中…）'}</pre>
            </>
          ) : meta.family === 'fileEdit' ? (
            <DiffBody oldText={diff?.oldText} newText={diff?.newText} />
          ) : meta.family === 'fileWrite' && typeof call.args.content === 'string' ? (
            <pre style={monoBlockStyle}>{call.args.content}</pre>
          ) : (
            <>
              <pre style={monoBlockStyle}>{summarizeArgs(call.args) || '（无参数）'}</pre>
              <pre style={monoBlockStyle}>{result?.summary ?? '（执行中…）'}</pre>
            </>
          )}
          {result?.truncated ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              输出已截断
            </Typography.Text>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
