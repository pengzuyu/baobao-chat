/**
 * IM 内嵌 Agent 卡控制器（D18 §2/§4，非 UI 纯逻辑）：
 * - (user, conv) → sessionId 映射（IndexedDB meta 持久；D01 §12.2-5 禁 localStorage）
 * - 落流：WS msg.send type=agent_card（服务端透传）
 * - 卡片 body 组装：agent store StreamItems → stages 投影
 * - 待同步池（2026-11-14 隐私裁决：默认零落流——问题/过程/回答全程仅本机可见，
 *   回合收口入池，用户手动「同步」才把仅结论 agent_card 发进会话；旧「回合开始
 *   立即落 running 卡 + 阶段边界 PATCH」写路径整体退役）
 */

import { localMetaGet, localMetaSet } from '../../../shared/api/localdb';
import { wsClient } from '../../../shared/api/ws';
import { toolCallCommand, type AgentCardBody, type AgentStage } from '../../../shared/components/AgentProcessCard';
import type { StreamItem } from '../../agent/store/agent';
import { useImStore } from '../store/im';

const MAP_KEY = 'agent_embedded_map'; // { [convId]: sessionId }

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === '1';

/** Agent 会话运行态集合（私密实时卡/重载对账/滚动跟随判定共用；
 *  与工作台 TURN_ACTIVE_STATUSES 同口径——原 MessageBubble 内私有定义迁此） */
export const AGENT_LIVE_STATUSES = new Set<string>([
  'running',
  'waiting_permission',
  'waiting_clarify',
  'waiting_review',
  'subagent_fanout',
  'delegating',
]);

export async function getEmbeddedSessionId(convId: string): Promise<string | null> {
  const map = (await localMetaGet<Record<string, string>>(MAP_KEY)) ?? {};
  return map[convId] ?? null;
}

export async function setEmbeddedSessionId(convId: string, sessionId: string): Promise<void> {
  const map = (await localMetaGet<Record<string, string>>(MAP_KEY)) ?? {};
  map[convId] = sessionId;
  await localMetaSet(MAP_KEY, map);
}

/** 落流 agent_card（2026-11-14 隐私裁决后唯一落流场景=手动同步仅结论卡；ack 回 msgId）。
 *  mock（浏览器演示）：WS 不在演示环境内，本地 im store 直接落卡 */
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

/** 分阶段更新已落流卡片（D18 §4.2：body 原样透传）——2026-11-14 隐私裁决退役：
 *  默认零落流后无 running 卡可 PATCH，服务端路由保留兼容旧版落流卡 */

// ── 待同步池（2026-11-14 隐私裁决）────────────────────────────────────────────
// 回合收口（done 且有结论）→ 入池（IndexedDB 持久，重载不丢）；用户手动「同步」
// → 仅结论 agent_card 落流 + 出池；「仅自己保留」→ 直接出池（工作台仍有全量历史）。
// 失败/中断轮无结论可同步，不入池。

/** 待同步回合（一问一答一轮；id 用确定性轮键 agc-{sid}-r{N} 幂等去重） */
export interface PendingAgentRound {
  id: string;
  sessionId: string;
  /** 流内 user 条目数（轮序；同步落流 token 的盐基） */
  round: number;
  /** 本轮问题（卡头标识；roundQuestionOf 产物） */
  question?: string;
  /** 最终回答 markdown（仅此一段随同步落流——思考/工具过程永不进会话） */
  conclusionMd: string;
  startedAt: number;
  endedAt: number;
}

const PENDING_KEY = 'agent_embedded_pending'; // { [convId]: PendingAgentRound[] }
const PENDING_CAP = 20; // 每会话封顶（防无限堆积；更早未处理轮静默淘汰）

export async function readPendingPool(): Promise<Record<string, PendingAgentRound[]>> {
  return (await localMetaGet<Record<string, PendingAgentRound[]>>(PENDING_KEY)) ?? {};
}

async function writePendingPool(pool: Record<string, PendingAgentRound[]>): Promise<void> {
  await localMetaSet(PENDING_KEY, pool);
}

/** 入池（按 id 幂等；时间序追加，封顶截旧） */
export async function addPendingRound(convId: string, item: PendingAgentRound): Promise<void> {
  const pool = await readPendingPool();
  const list = pool[convId] ?? [];
  if (list.some((x) => x.id === item.id)) return; // 幂等：写入器可能随流事件重跑
  pool[convId] = [...list, item].slice(-PENDING_CAP);
  await writePendingPool(pool);
}

/** 出池（同步成功/仅自己保留共用） */
export async function removePendingRound(convId: string, id: string): Promise<void> {
  const pool = await readPendingPool();
  const list = pool[convId];
  if (!list || !list.some((x) => x.id === id)) return;
  pool[convId] = list.filter((x) => x.id !== id);
  await writePendingPool(pool);
}

/** 待同步回合 → 仅结论同步卡 body（无思考/工具过程；接收方按普通 done 卡渲染） */
export function pendingSyncBody(item: PendingAgentRound): AgentCardBody {
  return {
    kind: 'embedded_agent',
    session_id: item.sessionId,
    status: 'done',
    stages: [{ t: 'conclusion', md: item.conclusionMd, ts: item.endedAt }],
    sources: [],
    rounds: 1,
    started_at: item.startedAt,
    ended_at: item.endedAt,
    question: item.question,
  };
}

/** 手动同步：仅结论卡落流（落流 token 带盐防撞号）+ 出池。失败抛错由调用方提示重试 */
export async function syncRoundToConv(convId: string, item: PendingAgentRound): Promise<void> {
  await landAgentCard(convId, agentCardRoundToken(item.sessionId, item.round), pendingSyncBody(item));
  await removePendingRound(convId, item.id);
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
 * 粗粒度阶段签名（阶段边界节流）——2026-11-14 隐私裁决随阶段 PATCH 写路径退役删除
 * （防落流风暴口径的最后一次实践见 git 历史；默认零落流后无此需求）。
 */

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
