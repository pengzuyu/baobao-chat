/**
 * 来电弹窗（05 篇 PRTC-03 + D17 群呼形态）：
 * - 1v1：头像/主叫名/类型 + 接听（绿）/拒接（红）
 * - 群呼（group=true）：标题"群通话邀请" + 加入（join 模式，非接答）/忽略
 * 多端联动（answered_elsewhere）/主叫取消（canceled）由 store 收窗；
 * 系统横幅形态与铃声不做（notification 域预留，登记）。
 */

import { LogIn, Phone, PhoneOff, Video } from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { useRtcStore } from '../store/rtcStore';

export function IncomingCallModal() {
  const incoming = useRtcStore((s) => s.incoming);
  const accept = useRtcStore((s) => s.acceptIncoming);
  const reject = useRtcStore((s) => s.rejectIncoming);
  const joinCall = useRtcStore((s) => s.joinCall);
  if (!incoming) return null;

  const group = !!incoming.group;
  const join = () => {
    const inc = incoming;
    useRtcStore.setState({ incoming: null });
    void joinCall(inc.call_id, inc.conv_id, inc.call_type, { uid: inc.caller.id, name: inc.caller.name });
  };

  return (
    <div className="rtc-incoming" data-testid="incoming-call-modal" data-group={group || undefined}>
      <div className="rtc-incoming__panel">
        <div className="rtc-incoming__title">{group ? '群通话邀请' : '来电'}</div>
        <div className="rtc-incoming__body">
          <Avatar name={incoming.caller.name} size={64} />
          <div className="rtc-incoming__name" data-testid="incoming-caller-name">
            {incoming.caller.name}
          </div>
          <div className="rtc-incoming__type">
            {incoming.call_type === 'video' ? (
              <>
                <Video size={14} /> 视频通话{group ? ' · 点击加入' : ''}
              </>
            ) : (
              <>
                <Phone size={14} /> 语音通话{group ? ' · 点击加入' : ''}
              </>
            )}
          </div>
        </div>
        <div className="rtc-incoming__actions">
          <button
            type="button"
            className="rtc-incoming__btn rtc-incoming__btn--reject"
            data-testid={group ? 'incoming-dismiss' : 'incoming-reject'}
            title={group ? '忽略' : '拒接'}
            onClick={reject}
          >
            <PhoneOff size={22} />
          </button>
          <button
            type="button"
            className="rtc-incoming__btn rtc-incoming__btn--accept"
            data-testid={group ? 'incoming-join' : 'incoming-accept'}
            title={group ? '加入' : '接听'}
            onClick={group ? join : () => void accept()}
          >
            {group ? <LogIn size={22} /> : <Phone size={22} />}
          </button>
        </div>
      </div>
    </div>
  );
}
