/**
 * LiveKitEngine（D17 统一媒体面，替换 RtcEngine P2P 引擎——rtc.signal SDP/ICE
 * 中转退役，1v1/群一致经 SFU）：
 * - join：connect(url, token) → 发布 mic（video 按通话类型）→ 参与者/轨道事件
 *   回调驱动 store 网格投影（adaptiveStream/dynacast 自带弱网降层，05 §3.4 免开发）
 * - 掉线重连由 SDK 内部 resume；Disconnected 回调驱动 UI 提示
 * - 轨道消费：video 经 participants[].videoTrack（UI MediaStream 挂载）；
 *   audio 由 UI <audio> 元素 attach（不自动 append body，行为可控）
 */

import { Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrackPublication } from 'livekit-client';
import type { RtcCallType } from '../model/types';

/** 参与者快照（MeetingStage 网格投影） */
export interface EngineParticipant {
  /** livekit identity：uid:did */
  identity: string;
  /** uid 段（本地用户判定/头像） */
  uid: string;
  /** 显示名（token name 下发） */
  name: string;
  isLocal: boolean;
  audioTrack?: MediaStreamTrack;
  videoTrack?: MediaStreamTrack;
  /** 静音（远端 publication.muted / 本端 track 状态） */
  micMuted: boolean;
  /** 屏幕共享轨（D17 P1；本端+远端，摄像头轨并存） */
  screenTrack?: MediaStreamTrack;
}

export type LkConnectionState = 'connected' | 'reconnecting' | 'failed' | 'disconnected';

export interface LkEngineCallbacks {
  onParticipants: (participants: EngineParticipant[]) => void;
  onConnectionChange: (state: LkConnectionState) => void;
}

export class LiveKitEngine {
  private room: Room | null = null;
  private cbs: LkEngineCallbacks;
  private closed = false;
  private callType: RtcCallType = 'audio';
  private screenTrack: MediaStreamTrack | null = null;

  micOn = true;
  camOn = false;
  screenOn = false;

  constructor(cbs: LkEngineCallbacks) {
    this.cbs = cbs;
  }

  /** 进房：connect → 发布轨道（采集失败/超时抛出由 store 降级为无媒体模式，信令照走） */
  async join(url: string, token: string, callType: RtcCallType): Promise<void> {
    this.callType = callType;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;
    this.bindRoomEvents(room);
    await room.connect(url, token);
    // 采集发布：audio 恒发；video 按类型（失败仅记状态不阻断——音频可先行）
    this.micOn = true;
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch {
      this.micOn = false;
    }
    if (callType === 'video') {
      try {
        await room.localParticipant.setCameraEnabled(true);
        this.camOn = true;
      } catch {
        this.camOn = false;
      }
    }
    this.cbs.onConnectionChange('connected');
    this.emitParticipants();
  }

  private bindRoomEvents(room: Room): void {
    room
      .on(RoomEvent.ParticipantConnected, () => this.emitParticipants())
      .on(RoomEvent.ParticipantDisconnected, () => this.emitParticipants())
      .on(RoomEvent.TrackSubscribed, () => this.emitParticipants())
      .on(RoomEvent.TrackUnsubscribed, () => this.emitParticipants())
      .on(RoomEvent.TrackMuted, () => this.emitParticipants())
      .on(RoomEvent.TrackUnmuted, () => this.emitParticipants())
      .on(RoomEvent.LocalTrackPublished, () => this.emitParticipants())
      .on(RoomEvent.LocalTrackUnpublished, () => this.emitParticipants())
      .on(RoomEvent.Reconnecting, () => this.cbs.onConnectionChange('reconnecting'))
      .on(RoomEvent.Reconnected, () => this.cbs.onConnectionChange('connected'))
      .on(RoomEvent.Disconnected, () => {
        if (!this.closed) this.cbs.onConnectionChange('disconnected');
      });
  }

  /** 远端参与者快照（轨道经 mediaStreamTrack 解包——livekit Track 非原生 MediaStreamTrack） */
  private remoteOf(p: RemoteParticipant): EngineParticipant {
    let audioTrack: MediaStreamTrack | undefined;
    let videoTrack: MediaStreamTrack | undefined;
    let screenTrack: MediaStreamTrack | undefined;
    let audioMuted = true;
    p.trackPublications.forEach((pub: RemoteTrackPublication) => {
      if (!pub.track) return;
      if (pub.kind === Track.Kind.Audio) {
        audioTrack = pub.track.mediaStreamTrack;
        audioMuted = pub.isMuted;
        return;
      }
      if (pub.kind !== Track.Kind.Video) return;
      // 视频按 source 分流：摄像头 vs 屏幕共享（05 篇 S3：可并存两路 Producer）
      if (pub.source === Track.Source.ScreenShare) screenTrack = pub.track.mediaStreamTrack;
      else videoTrack = pub.track.mediaStreamTrack;
    });
    const [uid] = p.identity.split(':');
    return {
      identity: p.identity,
      uid,
      name: p.name || uid,
      isLocal: false,
      audioTrack,
      videoTrack,
      screenTrack,
      micMuted: audioMuted,
    };
  }

  private emitParticipants(): void {
    const room = this.room;
    if (!room) return;
    const list: EngineParticipant[] = [];
    // 本端
    const localAudio = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
    const localVideo = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack;
    const [myUid] = room.localParticipant.identity.split(':');
    list.push({
      identity: room.localParticipant.identity,
      uid: myUid,
      name: room.localParticipant.name || myUid,
      isLocal: true,
      audioTrack: localAudio,
      videoTrack: localVideo,
      micMuted: !this.micOn,
    });
    // 本端共享轨（远端经 publication source 判定，见 remoteOf）
    const localScreen = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
    if (list[0]) list[0] = { ...list[0], screenTrack: localScreen };
    room.remoteParticipants.forEach((p) => list.push(this.remoteOf(p)));
    this.cbs.onParticipants(list);
  }

  toggleMic(): boolean {
    this.micOn = !this.micOn;
    void this.room?.localParticipant.setMicrophoneEnabled(this.micOn).catch(() => undefined);
    this.emitParticipants();
    return this.micOn;
  }

  toggleCam(): boolean {
    if (this.callType !== 'video') return false;
    this.camOn = !this.camOn;
    void this.room?.localParticipant.setCameraEnabled(this.camOn).catch(() => undefined);
    this.emitParticipants();
    return this.camOn;
  }

  /**
   * 屏幕共享开（D17 P1）：getDisplayMedia 采集 → 以 ScreenSharing source 发布。
   * 失败抛出（NotAllowedError=权限拒绝 5007 / 平台不支持——WKWebView 等运行时探测），
   * 由 store 统一降级提示；用户点系统"停止共享"条 → onended 自动回收。
   */
  async startScreenShare(): Promise<void> {
    if (!this.room || this.screenOn) return;
    const media = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 15 },
      audio: false,
    });
    const track = media.getVideoTracks()[0];
    if (!track) {
      media.getTracks().forEach((t) => t.stop());
      throw new Error('no-screen-track');
    }
    track.onended = () => {
      void this.stopScreenShare();
    };
    await this.room.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare });
    this.screenTrack = track;
    this.screenOn = true;
    this.emitParticipants();
  }

  /** 屏幕共享关（幂等；系统停止条同路回收） */
  async stopScreenShare(): Promise<void> {
    const track = this.screenTrack;
    this.screenOn = false;
    this.screenTrack = null;
    if (track && this.room) {
      try {
        await this.room.localParticipant.unpublishTrack(track, true);
      } catch {
        /* 已停止 */
      }
    }
    track?.stop();
    this.emitParticipants();
  }

  /** 离房（幂等；服务器侧 bye 信令由 store 发） */
  leave(): void {
    if (this.closed) return;
    this.closed = true;
    void this.stopScreenShare();
    try {
      void this.room?.disconnect();
    } catch {
      /* 已断开 */
    }
    this.room = null;
    this.cbs.onParticipants([]);
  }
}
