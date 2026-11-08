/**
 * IM WS 事件 → store/Query 绑定（应用级常驻，D03 §5.3 / D01 §4.2）：
 * 订阅随主布局（MainLayout）而非聊天页生命周期——任意页面收到 msg.new
 * 都会入流、更新会话摘要与未读徽标；聊天页只负责"进入会话"的已读时机。
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { wsClient } from '../../../shared/api/ws';
import { mapMsgNew } from '../api/im';
import type { MsgNewPayload } from '../model/types';
import { useImStore } from './im';

export function useImWsEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const offs = [
      wsClient.on<MsgNewPayload>('msg.new', (payload) => {
        useImStore.getState().appendIncoming(mapMsgNew(payload));
        void queryClient.invalidateQueries({ queryKey: ['im', 'convs'] });
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
      wsClient.on('conv.updated', () => void queryClient.invalidateQueries({ queryKey: ['im', 'convs'] })),
      wsClient.on('badge.updated', () => void queryClient.invalidateQueries({ queryKey: ['im', 'convs'] })),
    ];
    return () => offs.forEach((off) => off());
  }, [queryClient]);
}
