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
import type { AgentCardBody, AgentStage } from '../../../shared/components/AgentProcessCard';
import type { StreamItem } from '../../agent/store/agent';

const MAP_KEY = 'agent_embedded_map'; // { [convId]: sessionId }

export async function getEmbeddedSessionId(convId: string): Promise<string | null> {
  const map = (await localMetaGet<Record<string, string>>(MAP_KEY)) ?? {};
  return map[convId] ?? null;
}

export async function setEmbeddedSessionId(convId: string, sessionId: string): Promise<void> {
  const map = (await localMetaGet<Record<string, string>>(MAP_KEY)) ?? {};
  map[convId] = sessionId;
  await localMetaSet(MAP_KEY, map);
}

/** 落流 agent_card（首个阶段完成时调用；ack 回 msgId 供后续 PATCH） */
export async function landAgentCard(convId: string, clientMsgId: string, body: AgentCardBody): Promise<string | null> {
  const ack = await wsClient.request<{ msgId: string; seq: number }>('msg.send', {
    conv_id: convId,
    client_msg_id: clientMsgId,
    type: 'agent_card',
    body,
  });
  return ack?.msgId ?? null;
}

/** 分阶段更新已落流卡片（D18 §4.2：body 原样透传） */
export async function patchAgentCard(msgId: string, body: AgentCardBody): Promise<void> {
  await http.patch(`/messages/${encodeURIComponent(msgId)}/agent-card`, body);
}

/**
 * StreamItems → 卡片 stages 投影（工具/子任务/委派统一为 tool 行；
 * permission/user 不进卡——审批在活动卡弹框，用户消息本身在消息流）。
 */
export function stagesFromStream(items: StreamItem[]): { stages: AgentStage[]; sources: string[]; rounds: number } {
  const stages: AgentStage[] = [];
  const sources: string[] = [];
  let rounds = 0;
  for (const it of items) {
    switch (it.kind) {
      case 'reasoning':
        stages.push({ t: 'thinking', digest: it.text.slice(0, 2000), ts: Date.now() });
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
          status: r ? (r.ok ? 'ok' : r.blocked ? 'blocked' : 'fail') : 'running',
          ms: r?.durationMs,
          summary: r?.summary?.slice(0, 120),
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

/** 轮次幂等键（agc-{sessionId}-r{轮序}）：一轮问答一张卡，轮内追问/重试
 * 重复 msg.send 被服务端 client_msg_id 幂等去重回原 msgId；下轮提问键不同落新卡
 * （2026-11-10 口径调整：idle 即收卡，「会话终身一卡」改为「一轮一卡」） */
export function agentCardClientMsgId(sessionId: string, round: number): string {
  return `agc-${sessionId}-r${round}`;
}
