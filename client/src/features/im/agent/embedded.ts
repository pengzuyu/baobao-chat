/**
 * IM 内嵌 Agent 卡控制器（D18 §2/§4，非 UI 纯逻辑）：
 * - (user, conv) → sessionId 映射（IndexedDB meta 持久；D01 §12.2-5 禁 localStorage）
 * - 落卡（2026-11-25 本地化拍板）：提问与过程卡仅本机可见——不再 msg.send type=agent_card
 *   /REST PATCH 服务端（对方与群友全程无感知），改落 im store 纯本地消息
 *   （localState='local'）+ IndexedDB meta KV 轮次记录持久化（登出随 localClearAll 清除）
 * - 卡片 body 组装：agent store StreamItems → stages 投影
 */

import { localMetaGet, localMetaSet } from '../../../shared/api/localdb';
import { getAgentBridge } from '../../agent/bridge';
import { toolCallCommand, type AgentCardBody, type AgentStage } from '../../../shared/components/AgentProcessCard';
import type { StreamItem } from '../../agent/store/agent';
import { useImStore } from '../store/im';
import type { Message } from '../model/types';

const MAP_KEY = 'agent_embedded_map'; // { [convId]: sessionId }

export async function getEmbeddedSessionId(convId: string): Promise<string | null> {
  const map = (await localMetaGet<Record<string, string>>(MAP_KEY)) ?? {};
  return map[convId] ?? null;
}

/** 映射有效性校验+自愈（2026-11-16 幽灵映射事故）：映射可能指向 RT 已不存在的
 *  会话（旧壳/运行库换轨遗留——agent_input 打幽灵 id 被 RT 拒且全部静默）。
 *  权威判据 = session_list；幽灵则清映射返回 null（走重建：丢上下文好过永久静默死）。
 *  校验链路自身异常时保守放行（不阻断发送，失败由错误卡兜底）。 */
export async function validEmbeddedSessionId(convId: string): Promise<string | null> {
  const sid = await getEmbeddedSessionId(convId);
  if (!sid) return null;
  try {
    const known = (await getAgentBridge().listSessions()).some((s) => s.id === sid);
    if (known) return sid;
  } catch {
    return sid;
  }
  await clearEmbeddedSessionId(convId);
  return null;
}

/** 清除会话映射（幽灵自愈用；只删本 conv 行不动其他） */
export async function clearEmbeddedSessionId(convId: string): Promise<void> {
  const map = (await localMetaGet<Record<string, string>>(MAP_KEY)) ?? {};
  if (!map[convId]) return;
  delete map[convId];
  await localMetaSet(MAP_KEY, map);
}

export async function setEmbeddedSessionId(convId: string, sessionId: string): Promise<void> {
  const map = (await localMetaGet<Record<string, string>>(MAP_KEY)) ?? {};
  map[convId] = sessionId;
  await localMetaSet(MAP_KEY, map);
}

/** ── 本地轮次持久化（2026-11-25 拍板）：落流卡退役后，历史提问与过程卡改存本机
 *  IndexedDB meta KV——仅本设备可见，登出随 localClearAll 一并清除 ── */

/** 单轮记录：question 全文（恢复气泡与分享引用）/终态卡 body/轮 token（幂等键） */
export interface AgentRoundRecord {
  /** 轮 token（agentCardRoundToken）——本地卡幂等键（轮内稳定/跨轮唯一） */
  clientMsgId: string;
  /** 本轮提问全文（roundQuestionFullOf 口径；纯指令轮为空串） */
  question: string;
  /** 本轮提问附件（2026-11-26 机器人模式；恢复提问气泡带图——仅本机可见） */
  attachments?: Array<{ path: string; name: string; size: number; kind: 'image' | 'file' }>;
  /** 卡 body（落卡时 running 初态，终态 PATCH 回写快照） */
  body: AgentCardBody;
  /** 轮起点 ts（本轮最后一条 user 的 ts） */
  ts: number;
}

const ROUNDS_KEY_PREFIX = 'agent_rounds:';
const MAX_ROUNDS_PER_CONV = 50; // 每会话保留最近 50 轮（KV 截断，防无限膨胀）

export async function loadAgentRounds(convId: string): Promise<AgentRoundRecord[]> {
  return (await localMetaGet<AgentRoundRecord[]>(ROUNDS_KEY_PREFIX + convId)) ?? [];
}

async function saveAgentRounds(convId: string, rounds: AgentRoundRecord[]): Promise<void> {
  await localMetaSet(ROUNDS_KEY_PREFIX + convId, rounds.slice(-MAX_ROUNDS_PER_CONV));
}

/** 轮 token → 提问全文（内存注册表）：分享「发送到聊天」引用式拼装数据源；
 *  落卡时注册、恢复时重建。存量服务端旧卡无本机记录 → 分享回落卡头 question（30 字截断） */
const roundQuestions = new Map<string, string>();

function registerRoundQuestion(clientMsgId: string, question: string): void {
  if (question) roundQuestions.set(clientMsgId, question);
}

/** 分享取提问全文：无本机注册（存量旧卡）返回 undefined */
export function roundQuestionFull(clientMsgId: string): string | undefined {
  return roundQuestions.get(clientMsgId);
}

/** 本轮问题全文提取（roundQuestionOf 同口径**不截断**；KV 记录/恢复气泡/分享引用共用）：
 *  「在我端继续」指令场景取【补充说明】后段；纯指令（上下文自读）返回空串 */
export function roundQuestionFullOf(items: StreamItem[]): string {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind !== 'user') continue;
    let t = it.text.trim();
    const m = t.match(/【补充说明】([\s\S]*)/);
    if (m) t = m[1].trim();
    else if (t.startsWith('【上下文】')) return '';
    return t;
  }
  return '';
}

/** 本轮问题附件提取（2026-11-26）：最后一条 user 条目的 attachments（空=undefined） */
export function roundAttachmentsOf(items: StreamItem[]): Array<{ path: string; name: string; size: number; kind: 'image' | 'file' }> | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind === 'user') return it.attachments?.length ? it.attachments : undefined;
  }
  return undefined;
}

/** KV 轮次记录 → 本地消息序列（每轮=提问气泡（question 非空时）+ 过程卡）；
 *  seq 置 0 由 restoreLocalMessages 按序重分配负序 */
function roundRecordsToMessages(records: AgentRoundRecord[], convId: string, myUid: string): Message[] {
  const msgs: Message[] = [];
  for (const r of records) {
    if (r.question || (r.attachments ?? []).length > 0) {
      msgs.push({
        msgId: '',
        convId,
        seq: 0,
        clientMsgId: `${r.clientMsgId}-q`,
        senderId: myUid,
        senderName: '我',
        type: 'text',
        body: { text: r.question },
        status: 1,
        ts: r.ts,
        localState: 'local',
        attachments: r.attachments,
      });
    }
    msgs.push({
      msgId: '',
      convId,
      seq: 0,
      clientMsgId: r.clientMsgId,
      senderId: myUid,
      senderName: '我',
      type: 'agent_card',
      body: r.body,
      status: 1,
      ts: r.ts,
      localState: 'local',
    });
  }
  return msgs;
}

/** 挂载恢复（ChatPage 会话映射就绪后、EmbeddedAgentSync 挂载前调用）：KV 轮次重建
 *  本地提问气泡与卡灌回消息流 + 问题注册表重建。幂等——已在流内的 token 自动跳过。
 *  进行中轮的 running 卡可被 EmbeddedAgentSync 认领，WAL 回填流投影补终态 */
export async function restoreAgentRounds(convId: string, myUid: string): Promise<void> {
  const records = await loadAgentRounds(convId);
  if (records.length === 0) return;
  for (const r of records) registerRoundQuestion(r.clientMsgId, r.question);
  useImStore.getState().restoreLocalMessages(convId, roundRecordsToMessages(records, convId, myUid));
}

/**
 * 落卡（新回合立即调用——0 阶段 running 也落；2026-11-25 本地化）：不再走 WS
 * msg.send——落 im store 本地消息 + KV 轮次记录。幂等：同 token 重落回原卡。
 * @param clientMsgId 轮 token（agentCardRoundToken：轮内稳定/跨轮唯一）
 * @param question 本轮提问全文（注册表与 KV 记录；纯指令轮传空串）
 */
export async function landAgentCard(
  convId: string,
  clientMsgId: string,
  body: AgentCardBody,
  question: string,
  attachments?: Array<{ path: string; name: string; size: number; kind: 'image' | 'file' }>,
): Promise<void> {
  registerRoundQuestion(clientMsgId, question);
  useImStore.getState().upsertLocalAgentCard(convId, clientMsgId, body);
  const records = await loadAgentRounds(convId);
  if (records.some((r) => r.clientMsgId === clientMsgId)) return;
  await saveAgentRounds(convId, [
    ...records,
    { clientMsgId, question, body, ts: body.started_at ?? Date.now(), attachments },
  ]);
}

/** 分阶段更新本地卡（原 REST PATCH /messages/{id}/agent-card 退役）：只更新本机
 *  im store 副本；终态回写 KV 轮次记录，进行中态不写穿（防流式风暴） */
export async function patchAgentCard(convId: string, clientMsgId: string, body: AgentCardBody): Promise<void> {
  useImStore.getState().patchLocalAgentCard(convId, clientMsgId, body);
  if (body.status === 'running') return;
  const records = await loadAgentRounds(convId);
  const idx = records.findIndex((r) => r.clientMsgId === clientMsgId);
  if (idx < 0) return;
  const next = [...records];
  next[idx] = { ...next[idx], body };
  await saveAgentRounds(convId, next);
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
 * StreamItems → 卡片 stages 投影（工具/子任务统一为 tool 行；
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
      case 'error':
        // 错误行（8011 模型不可用/流中断、8010 超限）进卡：fail 态工具行样式，
        // 完整消息可展开——随落流卡持久化，IM 历史可见
        stages.push({
          t: 'tool',
          name: `错误 ${it.code}`,
          status: 'fail',
          summary: it.message.slice(0, 120),
          result: `${it.fatal ? '[fatal] ' : ''}${it.message}`,
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

/** 轮次落流 token（2026-11-20 修重复落卡写放大）：前缀+本轮 user 时间戳盐。
 *  盐绑**轮身份**而非调用时刻——旧 Date.now() 盐让同一轮每次重落都是新键，服务端
 *  client_msg_id 幂等永不命中，「重进聊天页重落旧轮」每次 INSERT 一行 agent_card
 *  （刷新 N 次历史多 N 张重复结果卡）。现口径：轮内稳定（重试/重复落流同键 → 幂等
 *  回原卡，只 PATCH 不写新行）、跨轮唯一（user ts 必不同）、跨重启 WAL 回填 ts 与
 *  内存 ts 有毫秒差则不同键（不撞 2026-11-11 事故的历史旧轮号） */
export function agentCardRoundToken(sessionId: string, round: number, userTs: number): string {
  return `${agentCardClientMsgId(sessionId, round)}-u${userTs.toString(36)}`;
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
