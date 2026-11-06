/**
 * IM Query hooks：key 统一走 shared/api/keys.ts 工厂；
 * WS 推送的精准失效由 ChatPage 订阅事件后按 wsInvalidationPrefixes 处理。
 */

import { useQuery } from '@tanstack/react-query';
import { qk } from '../../../shared/api/keys';
import { fetchConvs, fetchMessages } from './im';

export function useConversations(filter: string = 'all') {
  return useQuery({
    queryKey: qk.im.convs(filter),
    queryFn: () => fetchConvs(filter),
  });
}

export function useConversationMessages(convId: string | null) {
  return useQuery({
    queryKey: qk.im.messages(convId ?? 'none'),
    queryFn: () => fetchMessages(convId as string),
    enabled: !!convId,
  });
}
