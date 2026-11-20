/**
 * 回合容器（D33 §3.5 zcode 式平铺流）：
 * - 运行中：过程条目平铺全显示（思考/工具/技能/审批/子任务/中间正文），正文流式光标收尾
 * - 收口：过程完整折叠为一行统计（✓ 用时 · N次LLM调用 · N次工具 · N个子agent——
 *   复用 stagesFromStream+agentStatsText 两端口径单一来源），正文常开；点击折叠行展开
 * - 未决审批/提问与 error 行强制展开（不可折叠藏起——口径延续自回合气泡时代）
 * - memo 逐条引用比较（appendDelta 保旧条目引用稳定是前提，2026-11-11 卡顿口径延续）
 */

import { memo, useMemo, useState, type ReactNode } from 'react';
import { Typography, theme } from 'antd';
import { CheckCircle2, ChevronRight, Send } from 'lucide-react';
import { MarkdownText } from '../../../../shared/components/MarkdownText';
import { agentStatsText } from '../../../../shared/components/AgentProcessCard';
import { stagesFromStream } from '../../../im/agent/embedded';
import { useAgentStore, type StreamItem } from '../../store/agent';
import { ToolBlock } from './ToolBlock';
import { SkillCard } from './SkillCard';
import { ReasoningBlock } from './ReasoningBlock';
import { PermissionCard, type PermissionDecision } from '../PermissionCard';
import { ClarifyCard, type ClarifySubmit } from '../ClarifyCard';
import { SubagentCard } from '../SubagentCard';
import { TypingState } from '../TypingState';

type UserItem = Extract<StreamItem, { kind: 'user' }>;

/** 系统提示行（记忆沉淀/子任务汇总等；居中灰条） */
export function SystemRow({ text }: { text: string }) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        alignSelf: 'center',
        fontSize: 12,
        color: token.colorTextTertiary,
        background: token.colorFillQuaternary,
        borderRadius: 999,
        padding: '2px 12px',
        maxWidth: '92%',
        textAlign: 'center',
      }}
    >
      {text}
    </div>
  );
}

/** 错误行（8011/8010 等；不可静默，红字行内卡——不可折叠藏起） */
export function ErrorRow({ code, message, fatal }: { code: number; message: string; fatal: boolean }) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        alignSelf: 'stretch',
        fontSize: 12,
        lineHeight: 1.6,
        color: token.colorError,
        background: token.colorErrorBg,
        border: `1px solid ${token.colorErrorBorder}`,
        borderRadius: token.borderRadius,
        padding: '6px 10px',
      }}
    >
      {fatal ? '严重错误' : '出错了'}（{code}）：{message}
    </div>
  );
}

/** 中间轮正文（非最终回答，弱化展示：左边框+次要色） */
export function MidText({ children }: { children: ReactNode }) {
  const { token } = theme.useToken();
  return (
    <div style={{ fontSize: 13, color: token.colorTextSecondary, borderLeft: `2px solid ${token.colorBorderSecondary}`, paddingLeft: 8 }}>
      {children}
    </div>
  );
}

/** 澄清作答默认回调（模块级引用稳定——ToolBlock memo 不因 inline 闭包失效） */
const defaultRespondClarify = (questionId: string, s: ClarifySubmit) => {
  void useAgentStore.getState().respondClarify(questionId, s.answers, s.freeText || undefined);
};

/** 过程条目 → 平铺块（D33：工具不归组，逐条平铺；skill 走专属卡）。
 *  首个 user 前的散条（历史残留）也经此渲染。
 *  2026-11-18 门控内嵌：审批/澄清不再独立开框——Runtime 约定
 *  requestId="pr-{callId}" / questionId="q-{callId}"（toolCall 先落流、
 *  门控请求后到），先扫一遍建 callId 映射把 permission/clarify 挂到
 *  对应工具卡；配对成功的独立门控条目消融（不渲染——避免同命令双卡），
 *  配对失败（时序异常防御）回落原独立卡 */
export function renderStreamItems(
  items: StreamItem[],
  onRespond: (d: PermissionDecision) => void,
  onRespondClarify: (questionId: string, s: ClarifySubmit) => void = defaultRespondClarify,
): ReactNode[] {
  const permByCallId = new Map<string, Extract<StreamItem, { kind: 'permission' }>>();
  const clarifyByCallId = new Map<string, Extract<StreamItem, { kind: 'clarify' }>>();
  const callIds = new Set<string>();
  for (const it of items) {
    if (it.kind === 'tool') callIds.add(it.call.callId);
    else if (it.kind === 'permission' && it.request.requestId.startsWith('pr-')) permByCallId.set(it.request.requestId.slice(3), it);
    else if (it.kind === 'clarify' && it.request.questionId.startsWith('q-')) clarifyByCallId.set(it.request.questionId.slice(2), it);
  }
  const gateMatched = (id: string, prefix: 'pr-' | 'q-'): boolean => id.startsWith(prefix) && callIds.has(id.slice(prefix.length));

  return items.map((item) => {
    switch (item.kind) {
      case 'reasoning':
        return <ReasoningBlock key={item.key} text={item.text} streaming={item.streaming} />;
      case 'tool':
        return item.call.tool === 'skill' ? (
          <SkillCard key={item.key} item={item} />
        ) : (
          <ToolBlock
            key={item.key}
            item={item}
            permission={permByCallId.get(item.call.callId)}
            clarify={clarifyByCallId.get(item.call.callId)}
            onRespond={onRespond}
            onClarify={onRespondClarify}
          />
        );
      case 'agentText':
        return (
          <MidText key={item.key}>
            <MarkdownText text={item.text} />
          </MidText>
        );
      case 'permission':
        return gateMatched(item.request.requestId, 'pr-') ? null : <PermissionCard key={item.key} item={item} onRespond={onRespond} />;
      case 'clarify':
        return gateMatched(item.request.questionId, 'q-') ? null : (
          <ClarifyCard key={item.key} item={item} onRespond={(qid, s) => onRespondClarify(qid, s)} />
        );
      case 'subagent':
        return <SubagentCard key={item.key} item={item} />;
      case 'system':
        return <SystemRow key={item.key} text={item.text} />;
      case 'error':
        return <ErrorRow key={item.key} code={item.code} message={item.message} fatal={item.fatal} />;
      default:
        return null;
    }
  });
}

interface TurnBlockProps {
  /** 本轮用户消息（ts=回合起点；turnDoneAt=收口时刻） */
  user: UserItem;
  /** 用户消息之后的全过程条目（含最终回答 agentText） */
  items: StreamItem[];
  /** 回合进行中：过程平铺全显示 + 实时统计不打烊 */
  active: boolean;
  onRespond: (d: PermissionDecision) => void;
  /** 回合收口后「发送到聊天」入口（2026-11-20）：把最终回答以 bot 名义消息发到
   *  本会话对应的私聊/群聊；仅主时间线传入（右栏子 agent 流不出现）；
   *  返回是否成功（true=按钮翻「已发送到聊天」并禁用） */
  onShare?: (user: UserItem, items: StreamItem[]) => Promise<boolean> | boolean | void;
}

export const TurnBlock = memo(
  function TurnBlock({ user, items, active, onRespond, onShare }: TurnBlockProps) {
    const { token } = theme.useToken();
    // 最终回答 = 最后一段 agentText；其余进过程区
    let lastAnswerIdx = -1;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i].kind === 'agentText') {
        lastAnswerIdx = i;
        break;
      }
    }
    const processItems = lastAnswerIdx >= 0 ? items.filter((_, i) => i !== lastAnswerIdx) : items;
    const lastAnswer = lastAnswerIdx >= 0 ? (items[lastAnswerIdx] as Extract<StreamItem, { kind: 'agentText' }>) : null;

    // 未决审批/提问/错误不可折叠藏起（口径延续）
    const hasBlocking = processItems.some(
      (it) =>
        (it.kind === 'permission' && it.outcome === null) ||
        (it.kind === 'clarify' && it.answer === null) ||
        it.kind === 'error',
    );

    // 统计文案单一来源：stagesFromStream + agentStatsText（与 IM 卡同算法；
    // 收口后带冻结用时，运行中不带）
    const statsText = useMemo(() => {
      const { stages } = stagesFromStream(items);
      const durMs = !active && user.turnDoneAt ? user.turnDoneAt - user.ts : null;
      return agentStatsText(stages, durMs);
    }, [items, active, user.turnDoneAt, user.ts]);

    const [expanded, setExpanded] = useState(false);
    /** 本回合「发送到聊天」已发态（2026-11-20）：成功后翻文案禁用（memo 内组件态，
     *  props 引用稳定时保留；切会话重挂即复位=可再发一条） */
    const [shared, setShared] = useState(false);
    const showProcess = active || expanded || hasBlocking;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        {/* 收口折叠行：整段过程的折叠开关（运行中不渲染——过程平铺全显示） */}
        {!active && processItems.length > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={showProcess ? '收起过程' : '展开过程'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              width: 'fit-content',
              padding: '2px 8px 2px 4px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 12,
              color: token.colorTextSecondary,
              borderRadius: 6,
            }}
          >
            <ChevronRight
              size={12}
              aria-hidden
              style={{ transform: showProcess ? 'rotate(90deg)' : 'none', transition: 'transform .2s', color: token.colorTextTertiary }}
            />
            <CheckCircle2 size={12} aria-hidden style={{ color: token.colorSuccess }} />
            <span>{statsText}</span>
          </button>
        ) : null}
        {/* 运行中实时统计（不打烊口径） */}
        {active && processItems.length > 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12, paddingInline: 4 }}>
            {statsText}
          </Typography.Text>
        ) : null}
        {showProcess && processItems.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            {renderStreamItems(processItems, onRespond)}
          </div>
        ) : null}
        {/* 最终正文：常开 + 流式光标 */}
        {lastAnswer ? (
          <div style={{ position: 'relative', minWidth: 0 }}>
            <MarkdownText text={lastAnswer.text} />
            {active && lastAnswer.streaming ? (
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 7,
                  height: 15,
                  marginLeft: 2,
                  verticalAlign: 'text-bottom',
                  background: token.colorPrimary,
                  animation: 'agc-pulse 0.9s steps(2) infinite',
                }}
              />
            ) : null}
          </div>
        ) : null}
        {active && processItems.length === 0 && !lastAnswer ? <TypingState text="Agent 正在处理" /> : null}
        {/* 发送到聊天（2026-11-20 修订：固定发到本会话对应的来源私聊/群聊，无选择）：
            回合收口且有最终回答才出现——右对齐轻量文字按钮；已发态翻文案禁用
            （组件态不持久化，刷新后可再发=有意再发一条） */}
        {!active && onShare && lastAnswer ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              disabled={shared}
              onClick={() => {
                if (shared) return;
                void Promise.resolve(onShare(user, items)).then((ok) => {
                  if (ok !== false) setShared(true);
                });
              }}
              title={shared ? '本回合最终回答已发送' : '把本回合最终回答发送到本会话对应的聊天'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                border: 'none',
                background: 'transparent',
                cursor: shared ? 'default' : 'pointer',
                fontSize: 12,
                color: shared ? token.colorTextQuaternary : token.colorTextTertiary,
                borderRadius: 6,
              }}
              onMouseEnter={(e) => !shared && (e.currentTarget.style.color = token.colorPrimary)}
              onMouseLeave={(e) => (e.currentTarget.style.color = shared ? token.colorTextQuaternary : token.colorTextTertiary)}
            >
              <Send size={12} aria-hidden />
              {shared ? '已发送到聊天' : '发送到聊天'}
            </button>
          </div>
        ) : null}
      </div>
    );
  },
  (a, b) =>
    a.active === b.active &&
    a.onRespond === b.onRespond &&
    a.onShare === b.onShare &&
    a.user === b.user &&
    a.items.length === b.items.length &&
    a.items.every((it, i) => it === b.items[i]),
);
