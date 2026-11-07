/**
 * 来电弹窗（D04 PRTC-03 应用内形态，阶段一务实版）：
 * 头像/主叫名/类型 + 接听（绿）/拒接（红）；
 * 多端联动（answered_elsewhere）/主叫取消（canceled）由 store 收窗；
 * 系统横幅形态与铃声不做（notification 域预留，登记）。
 */

import { Phone, PhoneOff, Video } from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { useRtcStore } from '../store/rtcStore';

export function IncomingCallModal() {
  const incoming = useRtcStore((s) => s.incoming);
  const accept = useRtcStore((s) => s.acceptIncoming);
  const reject = useRtcStore((s) => s.rejectIncoming);
  if (!incoming) return null;

  return (
    <div className="rtc-incoming" data-testid="incoming-call-modal">
      <div className="rtc-incoming__panel">
        <div className="rtc-incoming__title">来电</div>
        <div className="rtc-incoming__body">
          <Avatar name={incoming.caller.name} size={64} />
          <div className="rtc-incoming__name" data-testid="incoming-caller-name">
            {incoming.caller.name}
          </div>
          <div className="rtc-incoming__type">
            {incoming.call_type === 'video' ? (
              <>
                <Video size={14} /> 视频通话
              </>
            ) : (
              <>
                <Phone size={14} /> 语音通话
              </>
            )}
          </div>
        </div>
        <div className="rtc-incoming__actions">
          <button
            type="button"
            className="rtc-incoming__btn rtc-incoming__btn--reject"
            data-testid="incoming-reject"
            title="拒接"
            onClick={reject}
          >
            <PhoneOff size={22} />
          </button>
          <button
            type="button"
            className="rtc-incoming__btn rtc-incoming__btn--accept"
            data-testid="incoming-accept"
            title="接听"
            onClick={() => void accept()}
          >
            <Phone size={22} />
          </button>
        </div>
      </div>
    </div>
  );
}
