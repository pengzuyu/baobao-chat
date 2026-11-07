// 会议域类型（21 篇 §5/服务端 REST 契约同构）
export interface MeetingParticipant {
  id: string;
  user_id: string;
  role: number; // 1 organizer 2 host 3 participant
  rsvp: number; // 1 pending 2 accepted 3 tentative 4 declined
  responded_at?: number;
}

export interface Meeting {
  id: string;
  series_id?: string;
  meeting_no: string;
  title: string;
  agenda_md: string;
  type: number; // 1 instant 2 scheduled
  organizer_id: string;
  host_id: string;
  status: number; // 1 scheduled 2 live 3 ended 4 canceled
  start_time: string; // ISO
  end_time: string;
  tz: string;
  participants?: MeetingParticipant[];
}

export interface CalendarEvent {
  id: string;
  user_id: string;
  source: number;
  ref_id: string;
  title: string;
  start_ts: string;
  end_ts: string;
  all_day: boolean;
  rsvp_status: number;
}

export interface BusyBlock {
  user_id: number;
  start: string;
  end: string;
  title: string;
}

export interface RecurRule {
  freq: 'daily' | 'weekly' | 'biweekly' | 'monthly';
  by_weekday?: number[]; // 1..7
  month_mode?: 'by_day' | 'nth_weekday';
  month_day?: number;
  nth?: number;
  count?: number;
  until_ms?: number;
}

export interface CreateMeetingReq {
  title: string;
  agenda_md?: string;
  instant?: boolean;
  start_time: number; // ms（instant 可 0）
  end_time: number;
  tz?: string;
  participants?: string[];
}

export interface CreateRecurringReq extends CreateMeetingReq {
  rule: RecurRule;
  skip_holidays?: boolean;
}
