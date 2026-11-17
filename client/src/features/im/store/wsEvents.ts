/**
 * IM WS 事件 → store/Query 绑定（应用级常驻，D03 §5.3 / D01 §4.2）：
 * 订阅随主布局（MainLayout）而非聊天页生命周期——任意页面收到 msg.new
 * 都会入流、更新会话摘要与未读徽标；聊天页只负责"进入会话"的已读时机。
 */

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { wsClient } from '../../../shared/api/ws';
import { qk } from '../../../shared/api/keys';
import { fetchPresences, mapMsgNew } from '../api/im';
import type {
  ConvStatePushPayload,
  ConvUpdatedPushPayload,
  MsgNewPayload,
  MsgReactionNewPayload,
  MsgRecallPayload,
  MsgUpdatedPayload,
  TypingPushPayload,
} from '../model/types';
import { useImStore } from './im';

export function useImWsEvents(): void {
  const queryClient = useQueryClient();

  // 在线状态快照（04 篇 §6.1）：登录首拉种子 + 重连对齐（onResync invalidate ['im'] 前缀命中）；
  // 此后 presence.changed 推送增量维护 store
  const presenceQuery = useQuery({ queryKey: qk.im.presence, queryFn: fetchPresences });
  useEffect(() => {
    if (presenceQuery.data) useImStore.getState().applyPresences(presenceQuery.data);
  }, [presenceQuery.data]);

  useEffect(() => {
    const invalidateConvs = () => void queryClient.invalidateQueries({ queryKey: ['im', 'convs'] });
    const offs = [
      wsClient.on<MsgNewPayload>('msg.new', (payload) => {
        useImStore.getState().appendIncoming(mapMsgNew(payload));
        invalidateConvs();
        // 已读时机②：仅当聊天页正打开该会话时才"可见即读"
        // （activeConvId 由 ChatPage 挂载设置、卸载清空，离开聊天页不自动已读）
        if (payload.conv_id === useImStore.getState().activeConvId) {
          useImStore.getState().markRead(payload.conv_id, payload.seq);
        }
      }),
      // 对方已读回执 → ✓✓ 渲染依据（04 篇 §4.2）
      wsClient.on<{ conv_id: string; user_id: string; read_seq: number }>('msg.receipt', (p) => {
        useImStore.getState().applyReceipt(p.conv_id, p.user_id, p.read_seq);
      }),
      // 撤回占位（INT-IM-03：seq 不断裂，原地转 system 形态）
      wsClient.on<MsgRecallPayload>('msg.recall', (p) => {
        useImStore.getState().applyRecall(p.conv_id, p.msg_id, p.operator_id);
        invalidateConvs();
      }),
      // 编辑原地更新（INT-IM-02："已编辑"角标）
      wsClient.on<MsgUpdatedPayload>('msg.updated', (p) => {
        useImStore.getState().applyUpdated(p.conv_id, p.msg_id, p.body, p.edited_at, p.edit_version);
        invalidateConvs();
      }),
      // 表情回应全量快照（INT-IM-23：端侧幂等合并）
      wsClient.on<MsgReactionNewPayload>('msg.reaction.new', (p) => {
        useImStore.getState().applyReactions(p.conv_id, p.msg_id, p.reactions);
      }),
      // 正在输入（INT-IM-11：TTL 5s 端内过期）
      wsClient.on<TypingPushPayload>('msg.typing', (p) => {
        if (p.user_id !== useImStore.getState().myUid) {
          useImStore.getState().applyTyping(p.conv_id, p.user_id);
        }
      }),
      // 会话事件分发（D03 §5.3）：kind=state 仅本人多端；meta/member/setting/status/announcement 全端
      wsClient.on<ConvStatePushPayload | ConvUpdatedPushPayload>('conv.updated', (p) => {
        if (p.kind === 'state') {
          const state = p as ConvStatePushPayload;
          const store = useImStore.getState();
          store.setConvs(
            store.convs.map((c) =>
              c.id === state.conv_id && c.my ? { ...c, my: { ...c.my, ...state.applied } } : c,
            ),
          );
          return;
        }
        // 群管理事件：快照/members_delta 合并（成员数、角色、公告、解散置灰）
        useImStore.getState().applyConvUpdated(p as ConvUpdatedPushPayload);
        invalidateConvs();
      }),
      wsClient.on('badge.updated', invalidateConvs),
      // 在线状态（D03 §5.3：presence.changed → store 投影）
      wsClient.on<{ uid: string; status: string }>('presence.changed', (p) => {
        useImStore.getState().applyPresence(p.uid, p.status);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [queryClient]);
}
