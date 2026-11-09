/**
 * MeetingWindow 独立会议窗口壳（D17 §4，meeting.html 入口的根组件）：
 * - 启动即取 Rust 侧一次性 handoff（token/身份/动作）——无交接数据=直接打开窗口的兜底提示
 * - 自治运行：http token provider + 自连 WS（did=meeting，服务端多端语义天然支持）+
 *   过期前 60s 自刷新（刷新失败提示回主窗重新发起）
 * - 按 action 分发到 rtcStore 既有动作（bootstrapHandoff），UI 复用 RtcOverlay 全套
 * 主窗在 Tauri 宿主下拉起本窗口；浏览器环境无此入口（主窗降级内联，launcher 口径）
 */

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { setTokenProvider, setUnauthorizedHandler, type ApiError } from '../../../shared/api/http';
import { resolveWsBase, wsClient } from '../../../shared/api/ws';
import type { MeetingHandoff } from '../../../shared/meeting/launcher';
import { apiRefresh } from '../../auth/api/auth';
import { useRtcStore } from '../store/rtcStore';
import { RtcOverlay, type RtcAuthSource } from '../components/RtcOverlay';

type Phase = 'taking' | 'ready' | 'no-handoff';

/** access token 过期前提前量（与主窗 auth store 同口径） */
const REFRESH_AHEAD_MS = 60_000;

/** handoff 基 auth 源（会议窗口自治：token 刷新后经 ref 回流内嵌浮层） */
function useHandoffAuth() {
  const tokenRef = useRef<string>('');
  const source: RtcAuthSource = {
    getToken: () => tokenRef.current || null,
    getRefreshToken: () => null,
    getExpiresAt: () => 0,
    getUid: () => '',
    getDisplayName: () => '',
  };
  return { tokenRef, source };
}

export function MeetingWindow() {
  const [phase, setPhase] = useState<Phase>('taking');
  const [fatal, setFatal] = useState('');
  const { tokenRef, source: handoffAuth } = useHandoffAuth();

  useEffect(() => {
    let alive = true;
    let refreshToken = '';
    let expiresAt = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      if (!refreshToken || !expiresAt) return;
      const wait = expiresAt - Date.now() - REFRESH_AHEAD_MS;
      if (wait <= 0) return;
      refreshTimer = setTimeout(async () => {
        try {
          const result = await apiRefresh(refreshToken);
          if (!alive) return;
          tokenRef.current = result.accessToken;
          setTokenProvider(() => tokenRef.current);
          refreshToken = result.refreshToken ?? refreshToken;
          expiresAt = result.expiresAt;
          // WS 换新 token 重建（connectArgs 覆盖，内部管理重连）
          wsClient.connect(resolveWsBase(), result.accessToken, 'meeting');
          scheduleRefresh();
        } catch {
          if (alive) setFatal('登录态已过期：请回主窗重新登录后再发起通话');
        }
      }, wait);
    };

    void (async () => {
      let h: MeetingHandoff;
      try {
        h = await invoke<MeetingHandoff>('meeting_take_handoff');
      } catch {
        if (alive) setPhase('no-handoff');
        return;
      }
      if (!alive) return;
      tokenRef.current = h.token;
      setTokenProvider(() => tokenRef.current);
      setUnauthorizedHandler((err: ApiError) => {
        setFatal(`请求被拒（${err.code}）：登录态可能已过期`);
      });
      refreshToken = h.refresh_token;
      expiresAt = h.expires_at;
      const store = useRtcStore.getState();
      store.setMyUid(h.uid);
      store.setMyDid('meeting');
      // 自连 WS（request 层自带重试，连接建立前的信令自然等待）
      wsClient.connect(resolveWsBase(), h.token, 'meeting');
      scheduleRefresh();
      await store.bootstrapHandoff({
        action: h.action,
        callId: h.call_id,
        convId: h.conv_id,
        video: h.video,
        peer: { uid: h.peer_uid, name: h.peer_name },
      });
      if (alive) setPhase('ready');
    })();

    return () => {
      alive = false;
      if (refreshTimer) clearTimeout(refreshTimer);
      wsClient.disconnect();
    };
  }, []);

  if (phase === 'no-handoff') {
    return (
      <div className="meeting-fallback" data-testid="meeting-no-handoff">
        通话窗口请从主应用内发起（群聊工具栏 / 通话卡片 / 来电弹窗）。
      </div>
    );
  }

  return (
    <div className="meeting-root">
      {fatal ? <div className="meeting-fatal" data-testid="meeting-fatal">{fatal}</div> : null}
      <RtcOverlay auth={handoffAuth} />
    </div>
  );
}
