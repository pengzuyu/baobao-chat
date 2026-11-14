/**
 * IM 内嵌 Agent 私密卡区（2026-11-14 隐私裁决；ChatPage 消息流尾部挂载）：
 * - 本会话 embedded Agent 的实时过程卡 + 待同步轮卡——全部**仅本人可见的本地渲染**
 *   （非 IM 消息，不落库不扇出，对向/群成员全程无感知）
 * - 待同步轮（回合已收口且有结论，IndexedDB 持久重载不丢）：仅结论卡 + 页脚
 *   「同步到会话 / 仅自己保留」——同步走 embedded.ts syncRoundToConv（仅结论
 *   agent_card 落流，无思考/工具过程），落流后真卡经 msg.new 进流、本地卡出池
 * - 当前 open 轮（最后一条 user 未收口）：实时卡（AgentCardMsg 订阅 agent store
 *   流投影，随 delta 平滑流式），收口后由 EmbeddedAgentSync 写入器转入待同步池
 * - 失败/中断轮无结论不入池：仅 open 轮期间可见，收口即随实时卡退场
 */

import { useEffect, useMemo } from 'react';
import { message } from 'antd';
import { useAgentStore, type StreamItem } from '../../agent/store/agent';
import { AgentCardMsg } from '../components/MessageBubble';
import type { AgentCardBody } from '../../../shared/components/AgentProcessCard';
import { pendingSyncBody, type PendingAgentRound } from './embedded';
import { usePendingRounds } from './pending';

const EMPTY_STREAM: StreamItem[] = [];
const EMPTY_PENDING: PendingAgentRound[] = [];

interface Props {
  convId: string;
  sessionId: string;
}

export function EmbeddedPrivateCards({ convId, sessionId }: Props) {
  const stream = useAgentStore((s) => s.streams[sessionId] ?? EMPTY_STREAM);
  const pending = usePendingRounds((s) => s.byConv[convId] ?? EMPTY_PENDING);
  const syncing = usePendingRounds((s) => s.syncing);

  // 池加载（挂载/会话切换；IndexedDB 真源 → 视图）
  useEffect(() => {
    void usePendingRounds.getState().load(convId);
  }, [convId]);

  // 当前 open 轮：最后一条 user 未收口（含乐观上屏瞬间——session 状态/回答事件
  // 未跟上时也立即出卡）；收口判定与 EmbeddedAgentSync 写入器同口径
  let lastUser: Extract<StreamItem, { kind: 'user' }> | null = null;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const it = stream[i];
    if (it.kind === 'user') {
      lastUser = it;
      break;
    }
  }
  const roundOpen = !!lastUser && !lastUser.turnDoneAt;

  const doSync = (item: PendingAgentRound) => {
    void usePendingRounds.getState().sync(convId, item).then((ok) => {
      if (!ok) message.error('同步失败，请重试');
    });
  };
  const doDismiss = (item: PendingAgentRound) => {
    void usePendingRounds.getState().dismiss(convId, item.id);
  };

  // open 轮实时卡合成 body（AgentCardMsg 内部 live 投影接管 stages）
  const runningBody = useMemo<AgentCardBody>(
    () => ({ kind: 'embedded_agent', session_id: sessionId, status: 'running', stages: [] }),
    [sessionId],
  );

  if (!roundOpen && pending.length === 0) return null;

  return (
    <>
      {/* 待同步轮（时间序；最新一轮默认展开，历史轮折叠成「未同步」迷你卡） */}
      {pending.map((item, i) => (
        <AgentCardMsg
          key={item.id}
          body={pendingSyncBody(item)}
          initialExpanded={i === pending.length - 1}
          privateSync={{
            onSync: () => doSync(item),
            onDismiss: () => doDismiss(item),
            busy: !!syncing[item.id],
          }}
        />
      ))}
      {/* 当前 open 轮实时卡（收口即被待同步轮接替；页脚同步按钮仅 done 轮出现） */}
      {roundOpen ? <AgentCardMsg body={runningBody} privateSync={{ onSync: () => {}, onDismiss: () => {} }} /> : null}
    </>
  );
}
