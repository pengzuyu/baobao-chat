/**
 * IM 内嵌 Agent 卡控制器（D18 §2/§4，非 UI 纯逻辑）：
 * - (user, conv) → sessionId 映射（IndexedDB meta 持久；D01 §12.2-5 禁 localStorage）
 * - 落流：WS msg.send type=agent_card（服务端透传）
 * - 分阶段更新：REST PATCH /messages/{id}/agent-card（msg.updated 扇出）
 * - 卡片 body 组装：agent store StreamItems → stages 投影
 */

import { localMetaGet, localMetaSet } from '../../../shared/api/localdb';
import { http } from '../../../shared/api/http';
import { wsClient } from '../../../shared/api/ws';
import { toolCallCommand, type AgentCardBody, type AgentStage } from '../../../shared/components/AgentProcessCard';
import type { StreamItem } from '../../agent/store/agent';
import { useImStore } from '../store/im';

const MAP_KEY = 'agent_embedded_map'; // { [convId]: sessionId }

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === '1';

export async function getEmbeddedSessionId(convId: string): Promise<string | null> {
  const map = (await localMetaGet<Record<string, string>>(MAP_KEY)) ?? {};
  return map[convId] ?? null;
}

export async function setEmbeddedSessionId(convId: string, sessionId: string): Promise<void> {
  const map = (await localMetaGet<Record<string, string>>(MAP_KEY)) ?? {};
  map[convId] = sessionId;
  await localMetaSet(MAP_KEY, map);
}

/** 落流 agent_card（新回合立即调用——0 阶段 running 卡也落；ack 回 msgId 供后续 PATCH）。
 *  mock（浏览器演示）：WS 不在演示环境内，本地 im store 直接落卡——活动卡已取消
 *  （2026-11-11），落流卡是唯一界面，无 mock 通道则演示无反馈 */
export async function landAgentCard(convId: string, clientMsgId: string, body: AgentCardBody): Promise<string | null> {
  if (USE_MOCK) {
    const im = useImStore.getState();
    const list = im.messagesByConv[convId] ?? [];
    const existed = list.find((m) => m.clientMsgId === clientMsgId);
    if (existed) return existed.msgId; // 幂等（同 clientMsgId 重落回原卡）
    let maxSeq = 0;
    for (const m of list) if (m.seq > maxSeq) maxSeq = m.seq;
    const msgId = `m-mock-agc-${maxSeq + 1}`;
    im.appendIncoming({
      msgId,
      convId,
      seq: maxSeq + 1,
      clientMsgId,
      senderId: im.myUid,
      senderName: '我',
      type: 'agent_card',
      body,
      status: 1,
      ts: Date.now(),
      localState: 'sent',
    });
    return msgId;
  }
  const ack = await wsClient.request<{ msgId: string; seq: number }>('msg.send', {
    conv_id: convId,
    client_msg_id: clientMsgId,
    type: 'agent_card',
    body,
  });
  return ack?.msgId ?? null;
}

/** 分阶段更新已落流卡片（D18 §4.2：body 原样透传；mock 本地更新 body） */
export async function patchAgentCard(msgId: string, body: AgentCardBody): Promise<void> {
  if (USE_MOCK) {
    useImStore.setState((s) => {
      for (const [cid, list] of Object.entries(s.messagesByConv)) {
        if (!list || !list.some((m) => m.msgId === msgId)) continue;
        return { messagesByConv: { ...s.messagesByConv, [cid]: list.map((m) => (m.msgId === msgId ? { ...m, body } : m)) } };
      }
      return s;
    });
    return;
  }
  await http.patch(`/messages/${encodeURIComponent(msgId)}/agent-card`, body);
}

/**
 * 当前轮片段（2026-11-11 修「新卡带上一轮答案」）：最后一条 user 之后的条目——
 * 落流卡/实时投影只喂本轮（喂全会话流会让新一轮卡在模型响应前顶着上一轮的
 * conclusion；工作台 TurnBubble 经 groupTurns 已按轮切片故无此问题）。
 */
export function currentRoundItems(items: StreamItem[]): StreamItem[] {
  let idx = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].kind === 'user') {
      idx = i;
      break;
    }
  }
  return idx >= 0 ? items.slice(idx + 1) : items;
}

/**
 * StreamItems → 卡片 stages 投影（工具/子任务/委派统一为 tool 行；
 * permission/user 不进卡——审批在活动卡弹框，用户消息本身在消息流）。
 * **入参须先经 currentRoundItems 切片**（直接喂全会话流=跨轮串内容）。
 */
export function stagesFromStream(items: StreamItem[]): { stages: AgentStage[]; sources: string[]; rounds: number } {
  const stages: AgentStage[] = [];
  const sources: string[] = [];
  let rounds = 0;
  for (const it of items) {
    switch (it.kind) {
      case 'reasoning':
        // streaming 旗标透传（瞬态）：IM 落流卡思考小卡按它精确判定「本段思考是否
        // 已收尾」（收尾即自动折叠）；落流 PATCH 前由 EmbeddedAgentSync 剥除
        stages.push({ t: 'thinking', digest: it.text.slice(0, 2000), streaming: it.streaming, ts: Date.now() });
        break;
      case 'agentText':
        rounds += 1;
        stages.push({ t: 'conclusion', md: it.text, ts: Date.now() });
        break;
      case 'tool': {
        const r = it.result;
        stages.push({
          t: 'tool',
          name: it.call.tool,
          // 2026-11-12 终端行口径：行内命令（run_command=命令原文/其他=首个字符串
          // 参数）+ 展开用完整结果（≤2000 字，随卡落库历史可见）
          command: toolCallCommand(it.call.tool, it.call.args)?.slice(0, 500),
          status: r ? (r.ok ? 'ok' : r.blocked ? 'blocked' : 'fail') : 'running',
          ms: r?.durationMs,
          summary: r?.summary?.slice(0, 120),
          result: r?.summary?.slice(0, 2000),
          ts: Date.now(),
        });
        break;
      }
      case 'subagent':
        stages.push({
          t: 'tool',
          name: `子任务 ${it.runId}`,
          status: it.status === 'running' ? 'running' : it.status === 'done' ? 'ok' : 'fail',
          summary: it.summary?.slice(0, 120) ?? it.taskDigest.slice(0, 120),
        });
        break;
      case 'delegate':
        stages.push({
          t: 'tool',
          name: `委派 ${it.backend}`,
          status: it.phase === 'resolved' ? (it.decision === 'reject' ? 'fail' : 'ok') : 'running',
          summary: it.end?.summary?.slice(0, 120),
        });
        break;
      default:
        break; // user/permission/system 不进卡
    }
  }
  return { stages, sources, rounds: Math.max(1, rounds) };
}

/**
 * 粗粒度阶段边界签名（活动卡落流/更新的 effect 依赖）：
 * 只含阶段数/类型/工具名与状态——**不含结论文本长度**（流式 delta 每个 token
 * 都变，细粒度签名会引发落流风暴，2026-11-10 真机实测事故）。结论 md 只随
 * 终态 patch 全量带出；思考 digest 同理。
 */
export function stagesSignature(stages: AgentStage[]): string {
  return stages.map((s) => `${s.t}:${s.name ?? ''}:${s.status ?? ''}`).join('|');
}

/**
 * 上下文自读指令（D18 §3.5 2026-11-10 修订）：升级/继续不搬运卡片内容——
 * agent 拿 conv_id 调 im_history 自读会话记录（含此前 agent_card 结论）。
 */
export function contextInstruction(convId: string, convName?: string): string {
  return `【上下文】请先调用工具 im_history（参数 conv_id=${convId}, limit=50）读取本会话${convName ? `「${convName}」` : ''}的最近消息（其中【Agent】开头的行是此前 AI 的回答），了解讨论上下文后，再继续处理我接下来的请求。`;
}

/** 轮次键前缀（agc-{sessionId}-r{轮序}；2026-11-10 口径：一轮问答一张卡）。
 *  ⚠ 不再直接作 client_msg_id 使用——轮序取内存流 user 条数，壳重启后计数归零，
 *  新轮复用历史键会被服务端 client_msg_id 幂等去重回旧轮卡（seq 靠顶），回答气泡
 *  跑到用户最新消息上方（2026-11-11 真机事故）。落流一律走 agentCardRoundToken */
export function agentCardClientMsgId(sessionId: string, round: number): string {
  return `agc-${sessionId}-r${round}`;
}

/** 轮次落流 token（2026-11-11 修重启撞号）：前缀+盐。轮内稳定（生成一次存 ref，
 *  轮内重试/ack 丢失重发同键幂等回原卡）、跨轮/跨重启唯一（永不与历史轮撞号） */
export function agentCardRoundToken(sessionId: string, round: number): string {
  return `${agentCardClientMsgId(sessionId, round)}-${Date.now().toString(36)}`;
}

/** embedded 会话初始标题（2026-11-11）：以来源会话命名——单聊「与xxx的对话」、
 * 群聊「xxx · 群聊」。convName 为服务端算好的显示名（单聊=对方名）。 */
export function embeddedTitle(convName: string, convType: number): string {
  const name = convName.trim();
  if (!name) return '聊天 Agent 会话';
  return convType === 1 ? `与${name}的对话` : `${name} · 群聊`;
}

/** 本轮问题提取（2026-11-11 落流卡卡头标识）：取流内最后一条 user 文本；
 * 「在我端继续」指令场景取【补充说明】后段；纯指令（上下文自读）返回 null 不标识 */
export function roundQuestionOf(items: StreamItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind !== 'user') continue;
    let t = it.text.trim();
    const m = t.match(/【补充说明】([\s\S]*)/);
    if (m) t = m[1].trim();
    else if (t.startsWith('【上下文】')) return undefined; // 纯自读指令，无可标识问题
    if (!t) return undefined;
    const chars = [...t];
    return chars.length > 30 ? `${chars.slice(0, 30).join('')}…` : t;
  }
  return undefined;
}

/** embedded 映射反查（工作台「回到聊天」按钮数据源）：sessionId → convId */
export async function convIdOfSession(sessionId: string): Promise<string | null> {
  const map = (await localMetaGet<Record<string, string>>(MAP_KEY)) ?? {};
  return Object.entries(map).find(([, sid]) => sid === sessionId)?.[0] ?? null;
}

/** 全部 embedded sessionId 集合（工作台日常区 💬 来源徽标用；挂载时读一次） */
export async function embeddedSessionIds(): Promise<Set<string>> {
  const map = (await localMetaGet<Record<string, string>>(MAP_KEY)) ?? {};
  return new Set(Object.values(map));
}
