/**
 * RtcOverlay 全局通话浮层（app 组合层挂载，05 篇 §4 + D17 §4）：
 * - WS 推送接线：rtc.ringing / rtc.state → rtcStore（rtc.signal 已退役，D17 §7）
 * - 入口路由（宿主分流）：Tauri=拉起独立会议窗口（token 经 Rust 内存信箱交接）；
 *   浏览器（dev/E2E）=主窗内联降级（原流程不变）
 * - bus 接线：im:invoke-call（ChatHeader/CallCard 回拨，group=群呼）→ 发起；
 *   rtc:join-call（进行中卡片[加入]）→ 加入
 * - 渲染：CallWindow（内联降级时的活动通话）+ IncomingCallModal（来电/群呼邀请）+ toast
 */

import { useEffect, useRef } from 'react';
import { on } from '../../../shared/bus';
import { wsClient } from '../../../shared/api/ws';
import { fetchConvMembers } from '../api/rtcApi';
import { useRtcStore } from '../store/rtcStore';
import type { RtcRingingPayload, RtcStatePayload } from '../model/types';
import { launchMeetingWindow, newMeetingCallId } from '../../../shared/meeting/launcher';
import { CallWindow } from './CallWindow';
import { IncomingCallModal, type MeetingAction } from './IncomingCallModal';

/** auth 源（组合层下发；features 间禁止横向 import，D01 §12.2） */
export interface RtcAuthSource {
  getToken: () => string | null;
  getRefreshToken: () => string | null;
  getExpiresAt: () => number;
  getUid: () => string;
  getDisplayName: () => string;
}

export function RtcOverlay({ auth }: { auth: RtcAuthSource }) {
  const toast = useRtcStore((s) => s.toast);
  // 通话中来电等待条（INT-RTC-16：仅 toast 形态，不弹窗不响铃）
  const callWaiting = useRtcStore((s) => s.callWaiting);
  const answerWaiting = useRtcStore((s) => s.answerWaiting);
  const dismissWaiting = useRtcStore((s) => s.dismissWaiting);
  const clearToast = useRtcStore((s) => s.clearToast);
  // auth 源固化（组合层可能传内联对象——重渲染不触发 bus 重绑/事件窗口）
  const authRef = useRef(auth);
  authRef.current = auth;

  /** 宿主分流：Tauri=独立会议窗口（handoff：token 不落盘）；浏览器=false 走主窗内联 */
  const openMeeting = async (
    action: MeetingAction,
    callId: string,
    convId: string,
    video: boolean,
    peer: { uid: string; name: string },
  ): Promise<boolean> => {
    const token = authRef.current.getToken();
    if (!token) return false;
    return launchMeetingWindow({
      token,
      refresh_token: authRef.current.getRefreshToken() ?? '',
      expires_at: authRef.current.getExpiresAt() ?? 0,
      uid: authRef.current.getUid(),
      display_name: authRef.current.getDisplayName(),
      action,
      call_id: callId,
      conv_id: convId,
      video,
      peer_uid: peer.uid,
      peer_name: peer.name,
    });
  };

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
      const type = video ? 'video' : 'audio';
      if (group) {
        void (async () => {
          const callId = newMeetingCallId();
          if (await openMeeting('outgoingGroup', callId, convId, video, { uid: '', name: '群通话' })) return;
          await useRtcStore.getState().startGroupCall(convId, type); // 浏览器降级
        })();
        return;
      }
      void fetchConvMembers(convId)
        .then(async (members) => {
          const myUid = useRtcStore.getState().myUid;
          const peer = members.find((m) => m.uid !== myUid && m.status === 1);
          if (!peer) {
            useRtcStore.setState({ toast: { text: '未找到可呼叫的成员', at: Date.now() } });
            return;
          }
          const callId = newMeetingCallId();
          if (await openMeeting('outgoing1v1', callId, convId, video, { uid: peer.uid, name: peer.displayName })) return;
          await useRtcStore.getState().startOutgoing(convId, { uid: peer.uid, name: peer.displayName }, type, callId);
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
      void (async () => {
        if (await openMeeting('joinGroup', callId, convId, video, { uid: '', name: '群通话' })) return;
        await useRtcStore.getState().joinCall(callId, convId, video ? 'video' : 'audio', { uid: '', name: '群通话' });
      })();
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
      <IncomingCallModal openMeeting={openMeeting} />
      {callWaiting ? (
        <div className="rtc-toast rtc-call-waiting" data-testid="rtc-call-waiting" role="alert">
          <span>
            {callWaiting.caller.name} 来电（{callWaiting.call_type === 'video' ? '视频' : '音频'}）
          </span>
          <button type="button" onClick={() => void dismissWaiting()}>
            拒接
          </button>
          <button type="button" className="rtc-call-waiting__answer" onClick={() => void answerWaiting()}>
            挂断并接听
          </button>
        </div>
      ) : null}
      {toast ? (
        <div className="rtc-toast" data-testid="rtc-toast">
          {toast.text}
        </div>
      ) : null}
    </>
  );
}
