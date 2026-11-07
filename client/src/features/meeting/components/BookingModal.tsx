/**
 * PMT-02 预约弹窗（21 §3.3）：人选/时间/议程 + 周期规则折叠（S3）+
 * 忙闲提示（freebusy 冲突检测，§4.3）。
 */
import { useMemo, useState } from 'react';
import { CalendarPlus, Clock, Repeat, Users, X } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import * as api from '../api/meeting';
import type { CreateRecurringReq, RecurRule } from '../model/types';

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

const localDT = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export function BookingModal({ onClose, onCreated }: Props) {
  const [title, setTitle] = useState('');
  const [participants, setParticipants] = useState('');
  const [start, setStart] = useState(localDT(new Date(Date.now() + 3600_000)));
  const [end, setEnd] = useState(localDT(new Date(Date.now() + 7200_000)));
  const [agenda, setAgenda] = useState('');
  const [recurring, setRecurring] = useState(false);
  const [freq, setFreq] = useState<RecurRule['freq']>('weekly');
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [count, setCount] = useState(8);
  const [busy, setBusy] = useState<string[] | null>(null);
  const [creating, setCreating] = useState(false);

  const startMs = useMemo(() => new Date(start).getTime() || 0, [start]);
  const endMs = useMemo(() => new Date(end).getTime() || 0, [end]);
  const durationMin = useMemo(
    () => (startMs && endMs ? Math.round((endMs - startMs) / 60000) : 0),
    [startMs, endMs],
  );

  const checkBusy = async () => {
    if (!startMs || !endMs) return;
    const blocks = await api.fetchFreeBusy(['me'], startMs - 3600_000, endMs + 3600_000);
    const conflict = blocks.filter(
      (b) => new Date(b.end).getTime() > startMs && new Date(b.start).getTime() < endMs,
    );
    setBusy(conflict.map((b) => b.title));
  };

  const toggleWeekday = (d: number) =>
    setWeekdays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));

  const create = async () => {
    if (!title.trim() || !startMs || !endMs || endMs <= startMs) return;
    setCreating(true);
    try {
      const base = {
        title: title.trim(),
        agenda_md: agenda,
        start_time: startMs,
        end_time: endMs,
        tz: 'Asia/Shanghai',
        participants: participants.split(/[,;，；\s]+/).map((s) => s.trim()).filter(Boolean),
      };
      if (recurring) {
        const rule: RecurRule = { freq, count };
        if (freq === 'weekly' || freq === 'biweekly') rule.by_weekday = weekdays;
        if (freq === 'monthly') rule.month_mode = 'by_day';
        await api.createRecurring({ ...base, rule } as CreateRecurringReq);
      } else {
        await api.createMeeting(base);
      }
      onCreated();
      onClose();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mtg-book__mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mtg-book">
        <div className="mtg-book__head">
          <span>
            <CalendarPlus size={15} /> 预约会议
          </span>
          <button className="mtg-book__close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="mtg-book__body">
          <input className="mtg-book__title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="会议主题（必填）" autoFocus />
          <label className="mtg-book__row">
            <Users size={14} />
            <input value={participants} onChange={(e) => setParticipants(e.target.value)} placeholder="参与者 uid（逗号分隔，组织者默认加入）" />
          </label>
          <div className="mtg-book__times">
            <label>
              <Clock size={13} /> 开始
              <input type="datetime-local" value={start} onChange={(e) => { setStart(e.target.value); setBusy(null); }} />
            </label>
            <label>
              结束
              <input type="datetime-local" value={end} onChange={(e) => { setEnd(e.target.value); setBusy(null); }} />
            </label>
            <button className="mtg-book__busy-check" onClick={() => void checkBusy()}>查忙闲</button>
          </div>
          {durationMin > 0 && <p className="mtg-book__duration">时长 {Math.floor(durationMin / 60) > 0 ? `${Math.floor(durationMin / 60)} 小时 ` : ''}{durationMin % 60} 分钟（15 分钟～24 小时）</p>}
          {busy && (busy.length > 0 ? <p className="mtg-book__conflict">⚠ 时间冲突：{busy.join('、')}</p> : <p className="mtg-book__free">✓ 所选时间空闲</p>)}
          <textarea rows={3} value={agenda} onChange={(e) => setAgenda(e.target.value)} placeholder="议程（Markdown，可选）" />

          <button className="mtg-book__recur-toggle" onClick={() => setRecurring((v) => !v)}>
            <Repeat size={13} /> 周期会议 {recurring ? '（已启用）' : '（单场）'}
          </button>
          {recurring && (
            <div className="mtg-book__recur">
              <label>
                频率
                <select value={freq} onChange={(e) => setFreq(e.target.value as RecurRule['freq'])}>
                  <option value="daily">每日</option>
                  <option value="weekly">每周</option>
                  <option value="biweekly">每两周</option>
                  <option value="monthly">每月（按日）</option>
                </select>
              </label>
              {(freq === 'weekly' || freq === 'biweekly') && (
                <div className="mtg-book__weekdays">
                  {WEEKDAYS.map((w, i) => (
                    <button key={w} className={weekdays.includes(i + 1) ? 'is-on' : ''} onClick={() => toggleWeekday(i + 1)}>
                      {w}
                    </button>
                  ))}
                </div>
              )}
              <label className="mtg-book__count">
                场次上限
                <input type="number" min={2} max={52} value={count} onChange={(e) => setCount(Number(e.target.value) || 8)} />
                （≤52）
              </label>
            </div>
          )}
        </div>
        <div className="mtg-book__foot">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button variant="primary" loading={creating} onClick={() => void create()} disabled={!title.trim() || endMs <= startMs}>
            创建
          </Button>
        </div>
      </div>
    </div>
  );
}
