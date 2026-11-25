/**
 * 定时任务 IPC 封装（D35）：纯本地调度，命令前缀 schedule_*。
 * 非 Tauri（浏览器 dev/preview）返回空数据/不可用标记，页面显示提示。
 */

import { invoke } from '@tauri-apps/api/core';
import { isTauriAvailable } from './tauri';

export type ScheduleKind = 'cron' | 'once' | 'workday';
export type ScheduleMode = 'ask' | 'auto-edit' | 'full-auto';
export type ScheduleStatus = 'active' | 'paused' | 'completed' | 'expired';
export type RunStatus = 'running' | 'waiting_approval' | 'success' | 'failed' | 'missed' | 'expired';

export type ScheduleSpec =
  | { type: 'cron'; expr: string }
  | { type: 'once'; at: number }
  | { type: 'workday'; time: string };

export interface ScheduleTask {
  id: string;
  name: string;
  prompt: string;
  workspace: string;
  schedule: ScheduleSpec;
  modelPolicy: 'auto' | 'fast' | 'strong';
  model: string | null;
  mode: ScheduleMode;
  status: ScheduleStatus;
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduleRun {
  id: string;
  taskId: string;
  plannedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  status: RunStatus;
  sessionId: string | null;
  error: string | null;
  summary: string | null;
}

export interface ScheduleTaskInput {
  name: string;
  prompt: string;
  workspace?: string;
  schedule: ScheduleSpec;
  modelPolicy?: 'auto' | 'fast' | 'strong';
  model?: string | null;
  mode?: ScheduleMode;
}

export interface ScheduleList {
  tasks: ScheduleTask[];
  engineRunning: boolean;
  calendar: { year: number; fetchedAt: number }[];
  calendarYears: { current: boolean };
}

export interface ScheduleEvent {
  kind: 'task_changed' | 'run_started' | 'run_changed' | 'run_finished';
  task?: ScheduleTask;
  deletedId?: string;
  run?: ScheduleRun;
}

const EMPTY: ScheduleList = {
  tasks: [],
  engineRunning: false,
  calendar: [],
  calendarYears: { current: false },
};

export function scheduleAvailable(): boolean {
  return isTauriAvailable();
}

export async function scheduleList(): Promise<ScheduleList> {
  if (!isTauriAvailable()) return EMPTY;
  return invoke<ScheduleList>('schedule_list');
}

export async function scheduleRuns(taskId: string): Promise<ScheduleRun[]> {
  if (!isTauriAvailable()) return [];
  const res = await invoke<{ runs: ScheduleRun[] }>('schedule_runs', { taskId });
  return res.runs;
}

export async function scheduleCreate(input: ScheduleTaskInput): Promise<ScheduleTask> {
  const res = await invoke<{ task: ScheduleTask }>('schedule_create', { input });
  return res.task;
}

export async function scheduleUpdate(id: string, input: ScheduleTaskInput): Promise<ScheduleTask> {
  const res = await invoke<{ task: ScheduleTask }>('schedule_update', { id, input });
  return res.task;
}

export async function scheduleDelete(id: string): Promise<void> {
  await invoke('schedule_delete', { id });
}

export async function scheduleSetEnabled(id: string, enabled: boolean): Promise<ScheduleTask> {
  const res = await invoke<{ task: ScheduleTask }>('schedule_set_enabled', { id, enabled });
  return res.task;
}

export async function scheduleRunNow(id: string): Promise<ScheduleRun> {
  const res = await invoke<{ run: ScheduleRun }>('schedule_run_now', { id });
  return res.run;
}

export async function scheduleCancelRun(runId: string): Promise<void> {
  await invoke('schedule_cancel_run', { runId });
}

export async function scheduleSyncCalendar(year?: number): Promise<{ year: number; fetchedAt: number }> {
  return invoke<{ year: number; fetchedAt: number }>('schedule_sync_calendar', { year: year ?? null });
}

export async function scheduleCalendarStatus(): Promise<{ years: { year: number; fetchedAt: number }[] }> {
  if (!isTauriAvailable()) return { years: [] };
  return invoke<{ years: { year: number; fetchedAt: number }[] }>('schedule_calendar_status');
}