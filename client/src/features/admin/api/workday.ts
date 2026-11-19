/**
 * 工作日日历 REST 封装（D35）：管理端 12 月日历页 + 客户端定时任务同步共用。
 * 服务端：internal/workday（默认周一~五工作日/六日周末，表内只存例外）。
 */

import { http } from '../../../shared/api/http';

export type WorkdayType = 'workday' | 'weekend' | 'holiday';
export type WorkdaySource = 'default' | 'manual' | 'import';

export interface WorkdayDay {
  date: string; // YYYY-MM-DD
  type: WorkdayType;
  name: string;
  source: WorkdaySource;
}

export interface WorkdayYear {
  year: number;
  days: WorkdayDay[];
}

export interface WorkdayDayInput {
  date: string;
  type: WorkdayType;
  name?: string;
}

export interface WorkdayDiffRow {
  date: string;
  action: 'added' | 'changed' | 'removed';
  oldType?: WorkdayType;
  newType?: WorkdayType;
  oldName?: string;
  newName?: string;
}

export interface WorkdayImportResult {
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  dryRun: boolean;
  changes: WorkdayDiffRow[];
}

/** 管理端读取全年（含 source 区分默认/已设置） */
export function fetchWorkdayYear(year: number): Promise<WorkdayYear> {
  return http.get<WorkdayYear>(`/admin/workday-calendar?year=${year}`);
}

/** 批量设置例外（服务端会把“等于默认规则且无名称”的条目归一为删除） */
export function upsertWorkdayDays(year: number, days: WorkdayDayInput[]): Promise<{ ok: boolean }> {
  return http.put<{ ok: boolean }>('/admin/workday-calendar/days', { year, days });
}

/** 恢复默认（dates 空=整年） */
export function resetWorkdayDays(year: number, dates: string[]): Promise<{ ok: boolean }> {
  return http.post<{ ok: boolean }>('/admin/workday-calendar/reset', { year, dates });
}

/** JSON 导入（dryRun=true 只返回差异预览） */
export function importWorkday(
  year: number,
  mode: 'merge' | 'replace',
  days: WorkdayDayInput[],
  dryRun: boolean,
): Promise<WorkdayImportResult> {
  return http.post<WorkdayImportResult>('/admin/workday-calendar/import', {
    version: 1,
    year,
    mode,
    dryRun,
    days,
  });
}

/** 客户端只读同步（登录即可；壳定时任务用） */
export function fetchWorkdayYearForClient(year: number): Promise<WorkdayYear> {
  return http.get<WorkdayYear>(`/workday-calendar?year=${year}`);
}