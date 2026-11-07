/**
 * PMT-03 会议详情抽屉（21 §3.4）：信息/参与者 RSVP 链/操作（开始=群通话
 * 入会/改期/取消；周期场可拆分系列）。
 */
import { useState } from 'react';
import { CalendarX2, Check, Play, Split, X } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import * as hooks from '../api/hooks';
import * as api from '../api/meeting';
import type { Meeting } from '../model/types';

interface Props {
  meeting: Meeting;
  myUid: string;
  onClose: () => void;
}

const RSVP_LABEL: Record<number, string> = { 1: '待回复', 2: '已接受', 3: '暂定', 4: '已拒绝' };
const STATUS_LABEL: Record<number, string> = { 1: '已预约', 2: '进行中', 3: '已结束', 4: '已取消' };

const localDT = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export function MeetingDetailDrawer({ meeting, myUid, onClose }: Props) {
  const rsvp = hooks.useRsvp();
  const cancel = hooks.useCancelMeeting();
  const start = hooks.useStartMeeting();
  const reschedule = hooks.useReschedule();
  const [newStart, setNewStart] = useState(localDT(new Date(meeting.start_time)));
  const [newEnd, setNewEnd] = useState(localDT(new Date(meeting.end_time)));
  const [startedNo, setStartedNo] = useState<string | null>(null);

  const isOrganizer = meeting.organizer_id === myUid;
  const myRow = (meeting.participants ?? []).find((p) => p.user_id === myUid);
  const canRsvp = !!myRow && myRow.role === 3 && meeting.status === 1;

  const doStart = async () => {
    const no = await start.mutateAsync(meeting.id);
    setStartedNo(no); // 客户端以 call_id=meeting_no 发起 join 模式群通话（rtc 群呼 UI 阶段二接线）
  };

  return (
    <div className="mtg-detail__mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="mtg-detail">
        <div className="mtg-detail__head">
          <div>
            <h3>{meeting.title}</h3>
            <small>
              {STATUS_LABEL[meeting.status]} · 会议号 {meeting.meeting_no}
              {meeting.series_id ? ' · 周期场' : ''}
            </small>
          </div>
          <button className="mtg-detail__close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="mtg-detail__body">
          <div className="mtg-detail__time">
            {new Date(meeting.start_time).toLocaleString('zh-CN')} ~{' '}
            {new Date(meeting.end_time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          </div>
          {meeting.agenda_md && <pre className="mtg-detail__agenda">{meeting.agenda_md}</pre>}

          <h4>参与者</h4>
          <ul className="mtg-detail__parts">
            {(meeting.participants ?? []).map((p) => (
              <li key={p.id}>
                <span>{p.user_id === meeting.organizer_id ? '★ ' : ''}{p.user_id}</span>
                <em className={`rsvp-${p.rsvp}`}>{RSVP_LABEL[p.rsvp]}</em>
              </li>
            ))}
          </ul>

          {canRsvp && (
            <div className="mtg-detail__rsvp">
              <Button variant="primary" onClick={() => rsvp.mutate({ id: meeting.id, rsvp: 2 })}>
                <Check size={13} /> 接受
              </Button>
              <Button variant="secondary" onClick={() => rsvp.mutate({ id: meeting.id, rsvp: 3 })}>
                暂定
              </Button>
              <Button variant="secondary" onClick={() => rsvp.mutate({ id: meeting.id, rsvp: 4 })}>
                拒绝
              </Button>
            </div>
          )}

          {startedNo && (
            <p className="mtg-detail__started">
              会议已开始（号 {startedNo}）——群通话窗口随 rtc 群呼 UI 阶段二拉起，登记
            </p>
          )}

          {isOrganizer && meeting.status === 1 && (
            <div className="mtg-detail__organizer">
              <h4>组织者操作</h4>
              <div className="mtg-detail__org-actions">
                <Button variant="primary" loading={start.isPending} onClick={() => void doStart()}>
                  <Play size={13} /> 开始会议
                </Button>
                <Button variant="danger" loading={cancel.isPending} onClick={() => { cancel.mutate(meeting.id); onClose(); }}>
                  <CalendarX2 size={13} /> 取消
                </Button>
              </div>
              <div className="mtg-detail__resched">
                <label>
                  改期
                  <input type="datetime-local" value={newStart} onChange={(e) => setNewStart(e.target.value)} />
                  <input type="datetime-local" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} />
                </label>
                <Button
                  variant="secondary"
                  onClick={() =>
                    reschedule.mutate({
                      id: meeting.id,
                      start: new Date(newStart).getTime(),
                      end: new Date(newEnd).getTime(),
                    })
                  }
                >
                  应用改期
                </Button>
              </div>
              {meeting.series_id && (
                <Button
                  variant="text"
                  onClick={() => void api.splitSeries(meeting.id)}
                  title="本场及之后拆为新系列（周期编辑三选一之二）"
                >
                  <Split size={13} /> 拆分系列（本场及之后）
                </Button>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
