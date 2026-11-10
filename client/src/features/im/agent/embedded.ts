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

/** 阶段边界判定：stages 数量或末项内容变化（活动卡 useEffect 依赖） */
export function stagesSignature(stages: AgentStage[]): string {
  return stages.map((s) => `${s.t}:${s.name ?? ''}:${s.status ?? ''}:${(s.md ?? s.digest ?? s.summary ?? '').length}`).join('|');
}
