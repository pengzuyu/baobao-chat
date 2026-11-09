/**
 * RtcOverlay 全局通话浮层（app 组合层挂载，05 篇 §4 + D17）：
 * - WS 推送接线：rtc.ringing / rtc.state → rtcStore（rtc.signal 已退役，D17 §7）
 * - bus 接线：im:invoke-call（ChatHeader/CallCard 回拨，group=群呼）→ 发起；
 *   rtc:join-call（进行中卡片[加入]）→ joinCall
 * - 渲染：CallWindow（活动通话·网格）+ IncomingCallModal（来电/群呼邀请）+ toast
 */

import { useEffect } from 'react';
import { on } from '../../../shared/bus';
import { wsClient } from '../../../shared/api/ws';
import { fetchConvMembers } from '../api/rtcApi';
import { useRtcStore } from '../store/rtcStore';
import type { RtcRingingPayload, RtcStatePayload } from '../model/types';
import { CallWindow } from './CallWindow';
import { IncomingCallModal } from './IncomingCallModal';

export function RtcOverlay() {
  const toast = useRtcStore((s) => s.toast);
  const clearToast = useRtcStore((s) => s.clearToast);

  // WS 两推送接线（组件挂载期常驻——全局浮层随 App 生命周期）
  useEffect(() => {
    const offs = [
      wsClient.on<RtcRingingPayload>('rtc.ringing', (p) => useRtcStore.getState().applyRinging(p)),
      wsClient.on<RtcStatePayload>('rtc.state', (p) => useRtcStore.getState().applyState(p)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // bus：会话工具栏入口 → 1v1（对端=单聊另一成员）/ 群呼（join 模式全员 ringing）
  useEffect(() => {
    const off = on('im:invoke-call', ({ convId, video, group }) => {
      const store = useRtcStore.getState();
      if (group) {
        void useRtcStore.getState().startGroupCall(convId, video ? 'video' : 'audio');
        return;
      }
      void fetchConvMembers(convId)
        .then((members) => {
          const myUid = store.myUid;
          const peer = members.find((m) => m.uid !== myUid && m.status === 1);
          if (!peer) {
            useRtcStore.setState({ toast: { text: '未找到可呼叫的成员', at: Date.now() } });
            return;
          }
          void useRtcStore.getState().startOutgoing(convId, { uid: peer.uid, name: peer.displayName }, video ? 'video' : 'audio');
        })
        .catch(() => {
          useRtcStore.setState({ toast: { text: '发起失败：会话成员获取失败', at: Date.now() } });
        });
    });
    return off;
  }, []);

  // bus：进行中群通话卡片[加入]（call_id/conv_id 来自卡片 body）
  useEffect(() => {
    const off = on('rtc:join-call', ({ callId, convId, video }) => {
      void useRtcStore.getState().joinCall(callId, convId, video ? 'video' : 'audio', {
        uid: '',
        name: '群通话',
      });
    });
    return off;
  }, []);

  // toast 3s 自清
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clearToast, 3000);
    return () => clearTimeout(t);
  }, [toast, clearToast]);

  return (
    <>
      <CallWindow />
      <IncomingCallModal />
      {toast ? (
        <div className="rtc-toast" data-testid="rtc-toast">
          {toast.text}
        </div>
      ) : null}
    </>
  );
}
