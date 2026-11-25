/**
 * 工具块（D33 §3.5 zcode 式平铺流）：左侧状态色条（运行中主色/落定灰/失败红）
 * + 头行（家族图标 + 动作词 + 关键参数单行截断 + 状态/耗时/exit）+ 家族化展开体：
 * - 终端：$ 命令 + 输出块
 * - 编辑：old/new 全量红绿行 diff（精确替换语义，无需 diff 算法）
 * - 写入：行数/字节规模 + 内容预览
 * - 提问（ask_user）：展开体=ClarifyForm 选项作答
 * - 其余：参数摘要 + 结果
 * 行为口径延续 D19：运行中自动展开、结果落定自动收回头行（手动点击可翻转）；
 * blocked 8020-8026 红条带沿用。tool=skill 不达本组件（流分发走 SkillCard）。
 *
 * 2026-11-18 审批/澄清内嵌：门控请求（permission.request/clarify.request）不再
 * 独立开框，经 renderStreamItems 按 requestId="pr-{callId}" / questionId="q-{callId}"
 * 配对挂到本卡——等待审批=黄条+头行「等待审批」+展开体审批控件（PermissionControls）；
 * 等待回答=主色条+展开体 ClarifyForm；落定后恢复常规工具形态（展开体顶部留终态标记行）。
 *
 * 2026-11-25 整卡化（用户口径：标题+命令+结果展开呈一个整体，不再三段分离）：
 * 外框=随状态淡色边框+左侧实色状态条；展开体内命令/参数条（浅底+下边线）与
 * 输出区连续同卡，独立灰块（monoBlockStyle）退役。
 *
 * 2026-11-25 弹窗化（用户口径推翻 11-18 内嵌）：未决审批/提问控件移出输出流，
 * 由 GateDock 浮于输入框上方（本卡头行只保留「等待审批/等待回答」状态+提示行）；
 * 落定后流内只保留终态结果（gateSettledRow：审批决定/所选答案）。
 */

import { memo, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Spin, Tag, Typography, theme } from 'antd';
import { ChevronRight } from 'lucide-react';
import { RISK_LABELS } from '../../bridge/types';
import type { StreamItem } from '../../store/agent';
import { PermissionSettled, scopeLabel, type PermissionItem } from '../PermissionCard';
import { classifyTool, contentScale, editDiffArgs, splitMcpName, toolHeadParam } from './toolFamilies';

type ToolItem = Extract<StreamItem, { kind: 'tool' }>;
type ClarifyItem = Extract<StreamItem, { kind: 'clarify' }>;

/** 8020/8022-8026 拦截码文案（14 篇 §7；8021 已随拒绝类退役 2026-11-23；
 *  8002=审批拒绝/超时（loop_runner Blocked） */
const BLOCK_LABELS: Record<number, string> = {
  8002: '用户拒绝/审批超时',
  8020: '权限/路径拦截',
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

/** 展开体同卡区块样式（组件内定义——依赖 token 随主题联动）：
 *  命令/参数条=浅底+下边线；输出区=白底连续同卡（2026-11-25 整卡化，
 *  原独立灰块 monoBlockStyle 退役） */
function useMonoRows() {
  const { token } = theme.useToken();
  const cmdRow: CSSProperties = {
    fontFamily: 'var(--bbc-font-mono)',
    fontSize: 12,
    padding: '6px 10px',
    background: token.colorFillQuaternary,
    borderBottom: `1px solid ${token.colorBorderSecondary}`,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: token.colorText,
    margin: 0,
  };
  const outRow: CSSProperties = {
    fontFamily: 'var(--bbc-font-mono)',
    fontSize: 12,
    padding: '6px 10px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxHeight: 260,
    overflowY: 'auto',
    color: token.colorTextSecondary,
    margin: 0,
  };
  return { cmdRow, outRow };
}

/** 澄清终态详情：问题 + 所选/自由作答（解析「label、label；补充：t」拼接串，
 *  两端同格式：真机 run_ask_user / 宿主 clarify.response / mock 均此拼接） */
function ClarifySettled({ answer, question, multiSelect }: { answer: NonNullable<ClarifyItem['answer']>; question: string; multiSelect: boolean }) {
  if (answer.decision === 'cancelled') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          已中断（提问未回答）
        </Typography.Text>
        <Typography.Text style={{ fontSize: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            问题：
          </Typography.Text>
          {question}
        </Typography.Text>
      </div>
    );
  }
  const sep = '；补充：';
  const idx = answer.answers.indexOf(sep);
  const picked = idx >= 0 ? answer.answers.slice(0, idx) : answer.answers;
  const free = idx >= 0 ? answer.answers.slice(idx + sep.length) : '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Typography.Text type="success" style={{ fontSize: 12 }}>
        已回答 · {multiSelect ? '多选' : '单选'}
      </Typography.Text>
      <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ wordBreak: 'break-word' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            问题：
          </Typography.Text>
          {question}
        </div>
        <div style={{ wordBreak: 'break-word' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {picked ? '选择：' : '回答：'}
          </Typography.Text>
          {picked || free}
        </div>
        {picked && free ? (
          <div style={{ wordBreak: 'break-word' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              补充：
            </Typography.Text>
            {free}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 编辑 diff 行（红删/绿增；精确替换语义=old 全红 new 全绿；
 *  2026-11-25 去自带边框/圆角——红绿行直接贴整卡边缘融入） */
function DiffBody({ oldText, newText }: { oldText?: string; newText?: string }) {
  const { token } = theme.useToken();
  const row = (prefix: '-' | '+', text: string, bg: string, fg: string) => (
    <div key={`${prefix}-${text}`} style={{ background: bg, color: fg, padding: '1px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
      {prefix} {text}
    </div>
  );
  return (
    <div
      style={{
        fontFamily: 'var(--bbc-font-mono)',
        fontSize: 12,
        lineHeight: 1.6,
        overflow: 'hidden',
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

export interface ToolBlockProps {
  item: ToolItem;
  /** 配对挂载的门控审批（renderStreamItems 按 requestId 前缀配对）——头行状态
   *  与落定终态详情用；未决控件由 GateDock 弹层渲染（2026-11-25 弹窗化） */
  permission?: PermissionItem;
  /** 配对挂载的澄清提问（ask_user 工具卡）——同上，控件在 GateDock */
  clarify?: ClarifyItem;
}

export const ToolBlock = memo(function ToolBlock({ item, permission, clarify }: ToolBlockProps) {
  const { token } = theme.useToken();
  const { call, result } = item;
  const running = !result;
  // 门控态：等待审批 / 等待回答（挂载未决时视为卡片的「运行中」——自动展开控件）
  const permPending = !!permission && permission.outcome === null;
  const clarifyPending = !!clarify && clarify.answer === null;
  const gatePending = permPending || clarifyPending;
  // 审批已允许、工具执行中（result 未落）→ 头行补「已允许 · 粒度」小字
  const permAllowed = !!permission && permission.outcome !== null && permission.outcome.decision === 'allow';
  const allowNote = permAllowed && running ? `已允许 · ${scopeLabel(permission.outcome === null ? undefined : permission.outcome.scope)}` : '';

  // D19 自动折叠：运行中（含门控等待）展开、结果落定自动收回头行
  const [open, setOpen] = useState(running || gatePending);
  useEffect(() => {
    setOpen(running || gatePending);
  }, [running, gatePending]);

  const meta = classifyTool(call.tool);
  const Icon = meta.icon;
  const blocked = result?.blocked;
  const failed = result ? !result.ok : false;
  const param = toolHeadParam(call.tool, call.args);
  const isTerm = meta.family === 'terminal';
  const scale = meta.family === 'fileWrite' ? contentScale(call.args) : null;
  const mcp = meta.family === 'mcp' ? splitMcpName(call.tool) : null;
  const diff = meta.family === 'fileEdit' ? editDiffArgs(call.args) : null;

  const edgeColor = gatePending
    ? permPending
      ? token.colorWarning
      : token.colorPrimary
    : running
      ? token.colorPrimary
      : failed || blocked
        ? token.colorError
        : token.colorBorderSecondary;

  const statusNode = permPending ? (
    <Typography.Text type="warning" style={{ fontSize: 12 }}>
      等待审批
    </Typography.Text>
  ) : clarifyPending ? (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      等待回答
    </Typography.Text>
  ) : running ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Spin size="small" aria-hidden />
      {allowNote ? (
        <Typography.Text type="success" style={{ fontSize: 12 }}>
          {allowNote}
        </Typography.Text>
      ) : null}
    </span>
  ) : result?.ok ? (
    <Typography.Text type={permAllowed ? 'success' : 'secondary'} style={{ fontSize: 12 }}>
      {permAllowed ? '审批通过 · ' : ''}
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

  /** 展开体顶部门控终态详情（落定后回看：审批状态+改后命令对比 / 问题+所选+补充） */
  const gateSettledRow = (): ReactNode => {
    if (permission && !permPending) {
      return <PermissionSettled item={permission} />;
    }
    if (clarify && !clarifyPending && clarify.answer) {
      return <ClarifySettled answer={clarify.answer} question={clarify.request.question} multiSelect={clarify.request.multiSelect} />;
    }
    return null;
  };
  const settledRow = gateSettledRow();

  // 整卡化（2026-11-25）：外框随状态淡色；左侧实色条=edgeColor 保留状态语义
  const outerBorder = gatePending
    ? permPending
      ? token.colorWarningBorder
      : token.colorPrimaryBorder
    : running
      ? token.colorPrimaryBorder
      : failed || blocked
        ? token.colorErrorBorder
        : token.colorBorderSecondary;
  const { cmdRow, outRow } = useMonoRows();

  return (
    <div
      style={{
        alignSelf: 'stretch',
        border: `1px solid ${outerBorder}`,
        borderLeft: `3px solid ${edgeColor}`,
        borderRadius: 6,
        overflow: 'hidden',
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
          padding: '5px 10px',
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
        <div
          style={{
            background: token.colorErrorBg,
            color: token.colorError,
            fontSize: 12,
            padding: '3px 10px',
            borderTop: `1px solid ${token.colorErrorBorder}`,
          }}
        >
          {blocked.code} · {BLOCK_LABELS[blocked.code] ?? '已拦截'} · {blocked.rule}
        </div>
      ) : null}
      {open ? (
        <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {gatePending ? (
            /* 弹窗化：控件在输入框上方 GateDock；流内只留指引行 */
            <Typography.Text type="secondary" style={{ fontSize: 12, padding: '8px 10px' }}>
              {permPending ? '等待审批——请在输入框上方的弹窗中操作' : '等待回答——请在输入框上方的弹窗中作答'}
            </Typography.Text>
          ) : (
            <>
              {settledRow ? (
                <div style={{ padding: '8px 10px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>{settledRow}</div>
              ) : null}
              {isTerm ? (
                <>
                  <pre style={cmdRow}>{`$ ${param ?? ''}`}</pre>
                  <pre style={outRow}>{result?.summary ?? '（执行中…）'}</pre>
                </>
              ) : meta.family === 'fileEdit' ? (
                <DiffBody oldText={diff?.oldText} newText={diff?.newText} />
              ) : meta.family === 'fileWrite' && typeof call.args.content === 'string' ? (
                <pre style={outRow}>{call.args.content}</pre>
              ) : meta.family === 'ask' && clarify ? null : (
                <>
                  <pre style={cmdRow}>{summarizeArgs(call.args) || '（无参数）'}</pre>
                  <pre style={outRow}>{result?.summary ?? '（执行中…）'}</pre>
                </>
              )}
              {result?.truncated ? (
                <Typography.Text type="secondary" style={{ fontSize: 12, padding: '4px 10px 6px' }}>
                  输出已截断
                </Typography.Text>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
});
