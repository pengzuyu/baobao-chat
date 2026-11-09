/**
 * 通话全屏窗（05 篇 PRTC-01 + D17 统一媒体面网格版）：
 * - 状态栏：呼吸点+状态文案+时长计时（群呼显示 N 人）
 * - 画面区：1v1=远端大画面+本端画中画；群=九宫格自适应（无视频者头像占位）
 * - 轨道：livekit track → MediaStream 挂 <video>；远端音频经隐藏 <audio> 附件播放
 * - 控制条：静音/摄像头/挂断（群=退出通话，剩余成员继续）
 * - mediaFailed（媒体面未配置/连接失败）：信令照走+横幅提示（无媒体模式）
 * - PiP/布局切换/共享/成员面板不做（P1，D17 §8）
 */

import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { formatDuration, useRtcStore } from '../store/rtcStore';
import type { ActiveCall } from '../store/rtcStore';
import type { EngineParticipant } from '../engine/LiveKitEngine';

/** 状态文案（主叫视角 dialing=等待对方/被叫已接 connecting=正在建立） */
function stateText(call: ActiveCall, memberCount: number): string {
  if (call.state === 'ended') return endReasonText(call.reason);
  if (call.group) {
    if (call.state === 'connecting') return '正在加入…';
    return memberCount > 0 ? `群通话中 · ${memberCount} 人` : '群通话中';
  }
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
    case 'all_left':
      return '全员已退出';
    case 'bye':
      return '通话已结束';
    default:
      return '通话已结束';
  }
}

/** 视频元素轨道挂载（track 变化时重建 MediaStream） */
function VideoTile({ track, muted, className }: { track?: MediaStreamTrack; muted: boolean; className: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = track ? new MediaStream([track]) : null;
  }, [track]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

/** 远端音频隐藏附件（不自动 append body，行为可控） */
function AudioSink({ track }: { track?: MediaStreamTrack }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = track ? new MediaStream([track]) : null;
    if (track) void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [track]);
  return <audio ref={ref} autoPlay playsInline style={{ display: 'none' }} />;
}

/** 宫格单元：视频轨可用→画面；否则头像占位（静音角标） */
function ParticipantTile({ p, big }: { p: EngineParticipant; big?: boolean }) {
  return (
    <div className={`rtc-tile${p.isLocal ? ' rtc-tile--local' : ''}`} data-testid="rtc-tile">
      {p.videoTrack ? (
        <VideoTile track={p.videoTrack} muted={p.isLocal} className="rtc-tile__video" />
      ) : (
        <div className={`rtc-tile__placeholder${big ? ' rtc-tile__placeholder--big' : ''}`}>
          <Avatar name={p.name} size={big ? 64 : 40} />
        </div>
      )}
      <div className="rtc-tile__name">
        {p.name}
        {p.isLocal ? '（我）' : ''}
      </div>
      {p.micMuted ? <div className="rtc-tile__muted" title="已静音"><MicOff size={13} /></div> : null}
      {!p.isLocal && p.audioTrack ? <AudioSink track={p.audioTrack} /> : null}
    </div>
  );
}

export function CallWindow() {
  const call = useRtcStore((s) => s.call);
  const participants = useRtcStore((s) => s.participants);
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

  // 1v1：远端大画面+本端 PiP；群：九宫格（本端恒在首位）
  const remote = participants.filter((p) => !p.isLocal);
  const local = participants.find((p) => p.isLocal);
  const main = remote[0];
  const hasAnyVideo = participants.some((p) => !!p.videoTrack);

  return (
    <div className="rtc-call-window" data-testid="rtc-call-window" data-state={call.state} data-group={call.group || undefined}>
      {/* 状态栏 */}
      <div className="rtc-call-window__status">
        <span className={`rtc-call-window__dot${connected ? ' rtc-call-window__dot--on' : ''}`} />
        <span data-testid="rtc-call-state">{stateText(call, participants.length)}</span>
        {call.startedAt || call.state === 'ended' ? (
          <span className="rtc-call-window__timer" data-testid="rtc-timer">
            {formatDuration(elapsed)}
          </span>
        ) : null}
        {call.mediaFailed ? <span className="rtc-call-window__media-warn">无媒体通话模式（媒体服务未就绪）</span> : null}
      </div>

      {/* 画面区 */}
      <div className={call.group ? 'rtc-call-window__grid' : 'rtc-call-window__stage'}>
        {call.group ? (
          participants.length > 0 ? (
            participants.map((p) => <ParticipantTile key={p.identity} p={p} />)
          ) : (
            <div className="rtc-call-window__placeholder" data-testid="rtc-stage-placeholder">
              <Avatar name={call.peer.name} size={64} />
              <div className="rtc-call-window__peer-hint">{call.mediaFailed ? '无媒体通话模式' : '正在等待成员加入…'}</div>
            </div>
          )
        ) : main && main.videoTrack ? (
          <>
            <ParticipantTile p={main} big />
            {local?.videoTrack ? <VideoTile track={local.videoTrack} muted className="rtc-call-window__pip" /> : null}
          </>
        ) : (
          <div className="rtc-call-window__placeholder" data-testid="rtc-stage-placeholder">
            <Avatar name={call.peer.name} size={64} />
            <div className="rtc-call-window__peer-name">{call.peer.name}</div>
            <div className="rtc-call-window__peer-hint">
              {hasAnyVideo ? '' : call.mediaFailed ? '无媒体通话模式（媒体服务未就绪）' : '无视频画面（音频模式）'}
            </div>
          </div>
        )}
      </div>

      {/* 控制条：静音/摄像头/挂断（群=退出） */}
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
          title={connected ? (call.group ? '退出通话' : '挂断') : '取消'}
          onClick={hangup}
        >
          {connected ? <PhoneOff size={22} /> : <Phone size={22} className="rtc-btn__rotate" />}
        </button>
      </div>
    </div>
  );
}
