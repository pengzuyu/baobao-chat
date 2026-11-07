/**
 * 通话全屏窗（D04 PRTC-01 阶段一务实版，overlay 形态）：
 * - 状态栏：呼吸点+状态文案（dialing/ringing/connecting/connected/ended）+ 时长计时
 * - 画面区：远端大画面 + 本端画中画（无媒体通话模式→头像占位）
 * - 控制条：静音/摄像头（track.enabled 即时切换）/挂断（红）
 * - PiP/布局/共享/成员面板不做（阶段一登记）
 */

import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { formatDuration, useRtcStore } from '../store/rtcStore';
import type { ActiveCall } from '../store/rtcStore';

/** 状态文案（主叫视角 dialing=等待对方/被叫已接 connecting=正在建立） */
function stateText(call: ActiveCall): string {
  if (call.state === 'ended') return endReasonText(call.reason);
  if (call.role === 'caller') {
    switch (call.state) {
      case 'dialing':
        return '正在等待对方接听…';
      case 'ringing':
        return '对方振铃中…';
      case 'connecting':
        return '正在建立连接…';
      case 'connected':
        return '通话中';
      default:
        return '呼叫中…';
    }
  }
  switch (call.state) {
    case 'connecting':
      return '正在接通…';
    case 'connected':
      return '通话中';
    default:
      return '接通中…';
  }
}

/** 终态文案（卡片共用口径） */
export function endReasonText(reason?: string): string {
  switch (reason) {
    case 'canceled':
      return '已取消';
    case 'declined':
      return '对方已拒绝';
    case 'busy':
      return '对方忙线中';
    case 'timeout':
      return '无人接听';
    case 'failed':
      return '连接失败';
    case 'bye':
      return '通话已结束';
    default:
      return '通话已结束';
  }
}

/** 视频元素 srcObject 绑定（stream 变化时重挂） */
function VideoTile({ stream, muted, className }: { stream: MediaStream | null; muted: boolean; className: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

export function CallWindow() {
  const call = useRtcStore((s) => s.call);
  const localStream = useRtcStore((s) => s.localStream);
  const remoteStream = useRtcStore((s) => s.remoteStream);
  const micOn = useRtcStore((s) => s.micOn);
  const camOn = useRtcStore((s) => s.camOn);
  const toggleMic = useRtcStore((s) => s.toggleMic);
  const toggleCam = useRtcStore((s) => s.toggleCam);
  const hangup = useRtcStore((s) => s.hangup);
  const [now, setNow] = useState(Date.now());

  // 时长计时（connected 起算每秒刷新；ended 冻结服务端权威时长）
  useEffect(() => {
    if (!call || call.state !== 'connected') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [call?.state, call]);

  if (!call) return null;
  const elapsed =
    call.state === 'ended'
      ? (call.serverDuration ?? 0)
      : call.startedAt
        ? Math.floor((now - call.startedAt) / 1000)
        : 0;
  const connected = call.state === 'connected';
  const hasVideoTrack = (call.callType === 'video' && (localStream?.getVideoTracks().length ?? 0) > 0) || (remoteStream?.getVideoTracks().length ?? 0) > 0;

  return (
    <div className="rtc-call-window" data-testid="rtc-call-window" data-state={call.state}>
      {/* 状态栏 */}
      <div className="rtc-call-window__status">
        <span className={`rtc-call-window__dot${connected ? ' rtc-call-window__dot--on' : ''}`} />
        <span data-testid="rtc-call-state">{stateText(call)}</span>
        {call.startedAt || call.state === 'ended' ? (
          <span className="rtc-call-window__timer" data-testid="rtc-timer">
            {formatDuration(elapsed)}
          </span>
        ) : null}
        {call.mediaFailed ? <span className="rtc-call-window__media-warn">无媒体通话模式（设备不可用）</span> : null}
      </div>

      {/* 画面区：远端大画面（无媒体→头像占位）+ 本端画中画 */}
      <div className="rtc-call-window__stage">
        {remoteStream || localStream ? (
          <VideoTile stream={remoteStream ?? localStream} muted={false} className="rtc-call-window__remote" />
        ) : (
          <div className="rtc-call-window__placeholder" data-testid="rtc-stage-placeholder">
            <Avatar name={call.peer.name} size={64} />
            <div className="rtc-call-window__peer-name">{call.peer.name}</div>
            <div className="rtc-call-window__peer-hint">{hasVideoTrack ? '' : '无视频画面（音频/信令模式）'}</div>
          </div>
        )}
        {localStream ? <VideoTile stream={localStream} muted className="rtc-call-window__pip" /> : null}
      </div>

      {/* 控制条：静音/摄像头/挂断 */}
      <div className="rtc-call-window__controls">
        <button
          type="button"
          className={`rtc-btn${micOn ? '' : ' rtc-btn--off'}`}
          data-testid="rtc-mic"
          title={micOn ? '静音' : '取消静音'}
          onClick={toggleMic}
        >
          {micOn ? <Mic size={20} /> : <MicOff size={20} />}
        </button>
        <button
          type="button"
          className={`rtc-btn${camOn ? '' : ' rtc-btn--off'}`}
          data-testid="rtc-cam"
          title={camOn ? '关闭摄像头' : '开启摄像头'}
          onClick={toggleCam}
          style={{ display: call.callType === 'audio' ? 'none' : undefined }}
        >
          {camOn ? <Video size={20} /> : <VideoOff size={20} />}
        </button>
        <button
          type="button"
          className="rtc-btn rtc-btn--hangup"
          data-testid="rtc-hangup"
          title={connected ? '挂断' : '取消'}
          onClick={hangup}
        >
          {connected ? <PhoneOff size={22} /> : <Phone size={22} className="rtc-btn__rotate" />}
        </button>
      </div>
    </div>
  );
}
