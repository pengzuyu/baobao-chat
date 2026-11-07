/**
 * 会议域 API（21 §6 REST；mock 桩集中底部）。
 */
import { http } from '../../../shared/api/http';
import type { BusyBlock, CalendarEvent, CreateMeetingReq, CreateRecurringReq, Meeting } from '../model/types';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK !== '0';

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') s.set(k, String(v));
  }
  return s.toString();
};

export async function createMeeting(req: CreateMeetingReq): Promise<Meeting> {
  if (USE_MOCK) return mockCreate(req);
  return http.post<Meeting>('/meetings', req);
}

export async function createInstant(title: string, participants: string[] = []): Promise<Meeting> {
  return createMeeting({ title, instant: true, start_time: 0, end_time: 0, participants });
}

export async function createRecurring(req: CreateRecurringReq): Promise<Meeting[]> {
  if (USE_MOCK) {
    const first = await mockCreate(req);
    return [first]; // mock 不展开
  }
  const data = await http.post<Meeting[]>('/meetings/recurrence', req);
  return data ?? [];
}

export async function listMyMeetings(from: number, to: number, includeCanceled = false): Promise<Meeting[]> {
  if (USE_MOCK) return mockMeetings().filter((m) => new Date(m.start_time).getTime() < to && new Date(m.end_time).getTime() > from);
  const data = await http.get<Meeting[]>(`/meetings?${qs({ from, to, include_canceled: includeCanceled ? 1 : undefined })}`);
  return data ?? [];
}

export async function fetchCalendar(from: number, to: number): Promise<CalendarEvent[]> {
  if (USE_MOCK) {
    return mockMeetings().map((m) => ({
      id: `ev-${m.id}`,
      user_id: 'me',
      source: 1,
      ref_id: m.id,
      title: m.title,
      start_ts: m.start_time,
      end_ts: m.end_time,
      all_day: false,
      rsvp_status: 2,
    }));
  }
  const data = await http.get<CalendarEvent[]>(`/meetings/calendar?${qs({ from, to })}`);
  return data ?? [];
}

export async function fetchFreeBusy(uids: string[], from: number, to: number): Promise<BusyBlock[]> {
  if (USE_MOCK) {
    return mockMeetings()
      .filter((m) => new Date(m.start_time).getTime() < to && new Date(m.end_time).getTime() > from)
      .map((m) => ({ user_id: Number(uids[0] ?? 0), start: m.start_time, end: m.end_time, title: m.title }));
  }
  const data = await http.get<BusyBlock[]>(`/meetings/freebusy?${qs({ uids: uids.join(','), from, to })}`);
  return data ?? [];
}

export async function fetchMeeting(id: string): Promise<Meeting> {
  if (USE_MOCK) return mockMeetings().find((m) => m.id === id) ?? mockMeetings()[0];
  return http.get<Meeting>(`/meetings/${id}`);
}

export async function rsvpMeeting(id: string, rsvp: number): Promise<void> {
  if (USE_MOCK) return;
  await http.post(`/meetings/${id}/rsvp`, { rsvp });
}

export async function rescheduleMeeting(id: string, start: number, end: number): Promise<void> {
  if (USE_MOCK) return;
  await http.post(`/meetings/${id}/reschedule`, { start_time: start, end_time: end });
}

export async function cancelMeeting(id: string): Promise<void> {
  if (USE_MOCK) return;
  await http.post(`/meetings/${id}/cancel`, {});
}

export async function startMeeting(id: string): Promise<string> {
  if (USE_MOCK) return mockMeetings().find((m) => m.id === id)?.meeting_no ?? '900000001';
  const data = await http.post<{ meeting_no: string }>(`/meetings/${id}/start`, {});
  return data.meeting_no;
}

export async function endMeeting(id: string): Promise<void> {
  if (USE_MOCK) return;
  await http.post(`/meetings/${id}/end`, {});
}

export async function splitSeries(meetingId: string): Promise<string> {
  if (USE_MOCK) return `series-${Date.now()}`;
  const data = await http.post<{ new_series_id: string }>(`/meetings/${meetingId}/series-split`, {});
  return data.new_series_id;
}

export async function updateSeriesAll(seriesId: string, title: string, agenda: string): Promise<void> {
  if (USE_MOCK) return;
  await http.post(`/meetings/series/${seriesId}/update-all`, { title, agenda_md: agenda });
}

// ---------------------------------------------------------------------------
// mock 桩
// ---------------------------------------------------------------------------

const mockMeetings = (): Meeting[] => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const at = (dOffset: number, hour: number, min = 0) => {
    const d = new Date(now + dOffset * day);
    d.setHours(hour, min, 0, 0);
    return d.toISOString();
  };
  return [
    {
      id: 'mt-1', meeting_no: '912345678', title: '部门周会', agenda_md: '上周回顾/本周计划',
      type: 2, organizer_id: '1001', host_id: '1001', status: 1,
      start_time: at(0, 10), end_time: at(0, 11), tz: 'Asia/Shanghai',
      participants: [
        { id: 'p1', user_id: '1001', role: 1, rsvp: 2 },
        { id: 'p2', user_id: '1002', role: 3, rsvp: 1 },
      ],
    },
    {
      id: 'mt-2', meeting_no: '923456789', title: '方案评审（带附件议程）', agenda_md: '',
      type: 2, organizer_id: '1002', host_id: '1002', status: 1,
      start_time: at(1, 15), end_time: at(1, 16), tz: 'Asia/Shanghai',
      participants: [
        { id: 'p3', user_id: '1002', role: 1, rsvp: 2 },
        { id: 'p4', user_id: '1001', role: 3, rsvp: 3 },
      ],
    },
    {
      id: 'mt-3', meeting_no: '934567890', title: '快速同步', agenda_md: '',
      type: 1, organizer_id: '1001', host_id: '1001', status: 3,
      start_time: at(-1, 9, 30), end_time: at(-1, 10, 0), tz: 'Asia/Shanghai',
    },
  ];
};

const mockCreate = (req: CreateMeetingReq): Meeting => {
  const now = Date.now();
  const start = req.instant || !req.start_time ? now : req.start_time;
  const end = req.instant || !req.end_time ? now + 30 * 60_000 : req.end_time;
  return {
    id: `mt-${Date.now()}`,
    meeting_no: String(900000001 + Math.floor(Math.random() * 89999999)),
    title: req.title,
    agenda_md: req.agenda_md ?? '',
    type: req.instant ? 1 : 2,
    organizer_id: '1001',
    host_id: '1001',
    status: 1,
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    tz: req.tz ?? 'Asia/Shanghai',
    participants: (req.participants ?? []).map((uid, i) => ({
      id: `p${i}`, user_id: uid, role: 3, rsvp: 1,
    })),
  };
};
