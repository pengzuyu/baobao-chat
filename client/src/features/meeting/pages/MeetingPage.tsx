/**
 * PMT-01 会议页（21 §3.2 周视图裁剪）：顶部周切换/预约/即时会 + 周网格
 * （7 列×整点行，事件块绝对定位）+ 详情抽屉。
 */
import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Zap } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { StateView } from '../../../shared/ui/StateView';
import { BookingModal } from '../components/BookingModal';
import { MeetingDetailDrawer } from '../components/MeetingDetailDrawer';
import { useMyMeetings } from '../api/hooks';
import { createInstant } from '../api/meeting';
import { useAuthStore } from '../../auth/store/auth';
import type { Meeting } from '../model/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 本周周一 0 点 */
const weekStart = (d: Date): Date => {
  const c = new Date(d);
  const dow = (c.getDay() + 6) % 7; // 周一=0
  c.setDate(c.getDate() - dow);
  c.setHours(0, 0, 0, 0);
  return c;
};

const MY_UID = '1001'; // mock 登录态 uid（真实登录态接线随 auth 域 perms，登记）

export function MeetingPage() {
  const [weekOf, setWeekOf] = useState(() => weekStart(new Date()));
  const [booking, setBooking] = useState(false);
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [instantBusy, setInstantBusy] = useState(false);

  const from = weekOf.getTime();
  const to = from + 7 * DAY_MS;
  const query = useMyMeetings(from, to);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(from + i * DAY_MS)),
    [from],
  );
  const today = useMemo(() => {
    const t = new Date();
    return t.getTime() >= from && t.getTime() < to ? t : null;
  }, [from, to]);

  const quickMeet = async () => {
    setInstantBusy(true);
    try {
      await createInstant('快速会议');
      void query.refetch();
    } finally {
      setInstantBusy(false);
    }
  };

  return (
    <div className="mtg-page">
      <header className="mtg-page__bar">
        <div className="mtg-page__nav">
          <button onClick={() => setWeekOf(new Date(from - 7 * DAY_MS))} aria-label="上一周">
            <ChevronLeft size={16} />
          </button>
          <span className="mtg-page__week">
            {weekOf.getMonth() + 1} 月 {weekOf.getDate()} 日 当周
          </span>
          <button onClick={() => setWeekOf(new Date(from + 7 * DAY_MS))} aria-label="下一周">
            <ChevronRight size={16} />
          </button>
          <button className="mtg-page__today" onClick={() => setWeekOf(weekStart(new Date()))}>
            今天
          </button>
        </div>
        <div className="mtg-page__actions">
          <Button variant="secondary" loading={instantBusy} onClick={() => void quickMeet()}>
            <Zap size={14} /> 即时会
          </Button>
          <Button variant="primary" onClick={() => setBooking(true)}>
            <CalendarDays size={14} /> 预约会议
          </Button>
        </div>
      </header>

      <StateView state={query.isLoading ? 'loading' : query.isError ? 'error' : 'ok'}>
        <div className="mtg-grid">
          <div className="mtg-grid__head">
            <span className="mtg-grid__gutter" />
            {days.map((d) => (
              <span key={d.getTime()} className={`mtg-grid__day${today && d.toDateString() === today.toDateString() ? ' is-today' : ''}`}>
                {WEEKDAYS[(d.getDay() + 6) % 7]} {d.getMonth() + 1}/{d.getDate()}
              </span>
            ))}
          </div>
          <div className="mtg-grid__body">
            <div className="mtg-grid__hours">
              {Array.from({ length: 24 }, (_, h) => (
                <span key={h}>{String(h).padStart(2, '0')}:00</span>
              ))}
            </div>
            {days.map((d) => {
              const dayStart = d.getTime();
              return (
                <div key={d.getTime()} className="mtg-grid__col">
                  {(query.data ?? [])
                    .filter((m) => {
                      const s = new Date(m.start_time).getTime();
                      const e = new Date(m.end_time).getTime();
                      return s < dayStart + DAY_MS && e > dayStart;
                    })
                    .map((m) => {
                      const s = new Date(m.start_time).getTime();
                      const e = new Date(m.end_time).getTime();
                      const top = ((Math.max(s, dayStart) - dayStart) / DAY_MS) * 100;
                      const height = Math.max(1.2, ((Math.min(e, dayStart + DAY_MS) - Math.max(s, dayStart)) / DAY_MS) * 100);
                      return (
                        <button
                          key={m.id}
                          className={`mtg-block mtg-block--s${m.status}`}
                          style={{ top: `${top}%`, height: `${height}%` }}
                          onClick={() => setSelected(m)}
                          title={`${m.title}（${new Date(m.start_time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）`}
                        >
                          <b>{m.title}</b>
                        </button>
                      );
                    })}
                </div>
              );
            })}
          </div>
        </div>
      </StateView>

      {booking && <BookingModal onClose={() => setBooking(false)} onCreated={() => void query.refetch()} />}
      {selected && (
        <MeetingDetailDrawer
          meeting={selected}
          myUid={(useAuthStore.getState().user?.uid ?? MY_UID).replace(/^u-/, '')}
          onClose={() => {
            setSelected(null);
            void query.refetch();
          }}
        />
      )}
    </div>
  );
}
