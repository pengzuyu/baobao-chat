/**
 * 通话卡片（D04 §4.5 call_card 渲染，物理位置 shared/components——与 FileCard 同级，D01 §12.1）：
 * 由 im 按消息类型 call_card 渲染；rtc 域经 bus 只广播实时态，避免 features 横向依赖（D04 §8 决策）。
 * - 方向图标：主叫=呼出（↗）/被叫=呼入（↘）——由调用方按 senderId 判定传入
 * - 状态文案：通话中（calling）/已结束（ended，含原因与时长）
 * - 再次呼叫：onRecall 回调（调用方经 bus 转发 rtc 域）
 */

import { PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing } from 'lucide-react';

/** call_card 消息体（服务端 rtc 域落流；与 server/internal/rtc/service.go cardBody 对齐） */
export interface CallCardBody {
  call_id: string;
  call_type: 'audio' | 'video';
  status: 'calling' | 'ended';
  duration?: number;
  reason?: string;
}

/** 终态文案（含未接/取消语义；与 CallWindow 口径一致） */
export function callCardText(body: CallCardBody, mine: boolean): string {
  if (body.status === 'calling') return '通话中…';
  switch (body.reason) {
    case 'canceled':
      return '已取消';
    case 'declined':
      return mine ? '对方已拒绝' : '已拒绝';
    case 'busy':
      return '对方忙线中';
    case 'timeout':
      return mine ? '无人接听' : '未接听';
    case 'failed':
      return '连接失败';
    default:
      return '通话已结束';
  }
}

/** 时长格式化 mm:ss（<1min 显示秒） */
export function formatCallDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

interface CallCardProps {
  body: CallCardBody;
  /** 方向：senderId===myUid → outgoing（im 调用方判定） */
  mine: boolean;
  /** 再次呼叫回调（bus 转发 rtc；未接/已结束可回拨） */
  onRecall?: (video: boolean) => void;
}

export function CallCard({ body, mine, onRecall }: CallCardProps) {
  const video = body.call_type === 'video';
  // 状态图标：进行中=电话动效；未接（timeout 呼入）= missed；其余按方向
  const missed = body.status === 'ended' && body.reason === 'timeout' && !mine;
  const Icon = body.status === 'calling' ? PhoneCall : missed ? PhoneMissed : mine ? PhoneOutgoing : PhoneIncoming;
  const connected = body.status === 'ended' && (body.duration ?? 0) > 0;

  return (
    <div className="call-card" data-testid="call-card">
      <div className={`call-card__icon${missed ? ' call-card__icon--missed' : ''}`}>
        <Icon size={18} />
      </div>
      <div className="call-card__meta">
        <div className="call-card__title">
          {video ? '视频通话' : '语音通话'}
          <span className="call-card__dir">{mine ? '呼出' : '呼入'}</span>
        </div>
        <div className={`call-card__status${missed ? ' call-card__status--missed' : ''}`} data-testid="call-card-status">
          {callCardText(body, mine)}
          {connected ? ` · ${formatCallDuration(body.duration ?? 0)}` : ''}
        </div>
      </div>
      {body.status === 'ended' && onRecall ? (
        <button
          type="button"
          className="call-card__recall"
          data-testid="call-card-recall"
          title={video ? '再次视频呼叫' : '再次语音呼叫'}
          onClick={() => onRecall(video)}
        >
          <PhoneCall size={15} />
          再次呼叫
        </button>
      ) : null}
    </div>
  );
}
