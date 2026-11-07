/**
 * RtcOverlay 全局通话浮层（app 组合层挂载，D04 §8）：
 * - WS 推送接线：rtc.ringing / rtc.state / rtc.signal → rtcStore
 * - bus 接线：im:invoke-call（ChatHeader/CallCard 回拨）→ 解析对端 → startOutgoing
 * - 渲染：CallWindow（活动通话）+ IncomingCallModal（来电）+ toast
 */

import { useEffect } from 'react';
import { on } from '../../../shared/bus';
import { wsClient } from '../../../shared/api/ws';
import { fetchConvMembers } from '../api/rtcApi';
import { useRtcStore } from '../store/rtcStore';
import type { RtcRingingPayload, RtcSignalPayload, RtcStatePayload } from '../model/types';
import { CallWindow } from './CallWindow';
import { IncomingCallModal } from './IncomingCallModal';

export function RtcOverlay() {
  const toast = useRtcStore((s) => s.toast);
  const clearToast = useRtcStore((s) => s.clearToast);

  // WS 三推送接线（组件挂载期常驻——全局浮层随 App 生命周期）
  useEffect(() => {
    const offs = [
      wsClient.on<RtcRingingPayload>('rtc.ringing', (p) => useRtcStore.getState().applyRinging(p)),
      wsClient.on<RtcStatePayload>('rtc.state', (p) => useRtcStore.getState().applyState(p)),
      wsClient.on<RtcSignalPayload>('rtc.signal', (p) => useRtcStore.getState().applySignal(p)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // bus：会话工具栏/卡片回拨 → 发起（对端=单聊另一成员；群聊入口 UI 已限制单聊）
  useEffect(() => {
    const off = on('im:invoke-call', ({ convId, video }) => {
      const store = useRtcStore.getState();
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
