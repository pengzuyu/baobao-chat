/**
 * 来电弹窗（05 篇 PRTC-03 + D17 §4 宿主分流）：
 * - 1v1：头像/主叫名/类型 + 接听（绿）/拒接（红）——Tauri=接听进独立会议窗口
 * - 群呼（group=true）：标题"群通话邀请" + 加入（join 模式，非接答）/忽略
 * 多端联动（answered_elsewhere）/主叫取消（canceled）由 store 收窗；
 * 系统横幅形态与铃声不做（notification 域预留，登记）。
 */

import { LogIn, Phone, PhoneOff, Video } from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { useRtcStore } from '../store/rtcStore';

/** 会议窗口动作类型（outgoing/accept/join 四态的来电子集） */
export type MeetingAction = 'outgoing1v1' | 'outgoingGroup' | 'accept1v1' | 'joinGroup';

interface Props {
  /** Tauri 宿主下拉起独立会议窗口（返回 false=浏览器降级主窗内联） */
  openMeeting: (action: MeetingAction, callId: string, convId: string, video: boolean, peer: { uid: string; name: string }) => Promise<boolean>;
}

export function IncomingCallModal({ openMeeting }: Props) {
  const incoming = useRtcStore((s) => s.incoming);
  const accept = useRtcStore((s) => s.acceptIncoming);
  const reject = useRtcStore((s) => s.rejectIncoming);
  const joinCall = useRtcStore((s) => s.joinCall);
  if (!incoming) return null;

  const group = !!incoming.group;
  const peer = { uid: incoming.caller.id, name: incoming.caller.name };
  const video = incoming.call_type === 'video';

  /** 接听/加入：优先独立会议窗口；浏览器降级主窗内联 */
  const answer = async () => {
    const inc = incoming;
    useRtcStore.setState({ incoming: null });
    if (group) {
      if (await openMeeting('joinGroup', inc.call_id, inc.conv_id, video, peer)) return;
      await joinCall(inc.call_id, inc.conv_id, inc.call_type, peer);
      return;
    }
    if (await openMeeting('accept1v1', inc.call_id, inc.conv_id, video, peer)) return;
    // 浏览器降级：恢复 incoming 走原接听流（acceptIncoming 依赖 store 状态）
    useRtcStore.setState({ incoming: inc });
    await accept();
  };

  const join = () => {
    void answer();
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
            {video ? (
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
            onClick={group ? join : () => void answer()}
          >
            {group ? <LogIn size={22} /> : <Phone size={22} />}
          </button>
        </div>
      </div>
    </div>
  );
}
