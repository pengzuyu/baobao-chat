/**
 * 完成通知双档（D16 P1-6 + 14 篇 §3.3 OQ-C32）：
 * - 本地档：工作台不可见（非 /agent 路由或窗口最小化）弹系统通知；
 * - 跨端档：run 终态上报服务端 notify 域（POST /notify/agent-tasks）→
 *   agent.task.completed 推其它在线设备 + 通知中心落卡（kind=agent_done）。
 * 降级：非 Tauri 宿主/权限拒绝/插件缺失/上报失败一律静默（通知是增益不是依赖）。
 * D12：弹通知前查服务端通知偏好（/me/notify-pref，60s 内存缓存）——免打扰
 * 时段（all-day 恒静默 / work-night 22:00-08:00）与 msg_notify 总开关静默
 * 系统通知（红点/通知中心照常）；取偏好失败按默认放行（增益不阻断）。
 */

import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { http } from '../../../shared/api/http';
import { isTauriAvailable } from './tauri';

/** 工作台是否可见（路由在 agent 域且页面未隐藏） */
export function workbenchVisible(): boolean {
  if (typeof document !== 'undefined' && document.hidden) return false;
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/agent');
}

// ── 通知偏好（D12：60s 内存缓存；失败按默认双开+off 放行）──

interface LightNotifyPref {
  msg_notify: boolean;
  dnd_range: 'off' | 'work-night' | 'all-day';
}

let prefCache: { at: number; pref: LightNotifyPref } | null = null;
const PREF_TTL_MS = 60_000;

/** 用户当前偏好（缓存兜底；离线/失败回落默认） */
async function currentPref(): Promise<LightNotifyPref> {
  const def: LightNotifyPref = { msg_notify: true, dnd_range: 'off' };
  if (prefCache && Date.now() - prefCache.at < PREF_TTL_MS) return prefCache.pref;
  try {
    const p = await http.get<LightNotifyPref>('/me/notify-pref');
    prefCache = { at: Date.now(), pref: { msg_notify: p.msg_notify, dnd_range: p.dnd_range } };
    return prefCache.pref;
  } catch {
    return def;
  }
}

/** 偏好缓存失效（设置页保存后 invalidate 由查询失效触发；此处 60s 自然过期兜底） */
export function invalidateNotifyPrefCache(): void {
  prefCache = null;
}

/** dnd 判定（本地时区；all-day 恒真 / work-night 22:00-08:00 跨夜） */
function dndActive(range: LightNotifyPref['dnd_range']): boolean {
  if (range === 'all-day') return true;
  if (range === 'work-night') {
    const h = new Date().getHours();
    return h >= 22 || h < 8;
  }
  return false;
}

/** 通用系统通知（懒申请权限；任何失败静默——通知是增益不是依赖；E7 多屏提示复用） */
export async function sendSystemNotification(title: string, body: string): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === 'granted';
    }
    if (granted) sendNotification({ title, body });
  } catch {
    // 插件缺失/权限拒绝：静默
  }
}

/** 弹系统通知（偏好闸门版——Agent 完成专用，D12） */
export async function notifyAgentDone(title: string, body: string): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    // 偏好闸门（D12）：总开关关/免打扰时段 → 系统通知静默（红点保留）
    const pref = await currentPref();
    if (!pref.msg_notify || dndActive(pref.dnd_range)) return;
  } catch {
    // 偏好读取失败按默认放行（增益不阻断）
  }
  await sendSystemNotification(title, body);
}

/**
 * 定时任务等待审批（D35）：审批是需要用户动作的时效事件，**不受免打扰静默**
 * （夜里等待审批被吞会导致任务超时被拒）；仅 Tauri 宿主弹系统通知。
 */
export async function notifyScheduleApproval(title: string, body: string): Promise<void> {
  await sendSystemNotification(title, body);
}

// ── 跨端档：run 终态上报（14 篇 §3.3；服务端幂等键 run_id+status，重试安全）──

/** 上报体（snake，对齐服务端 AgentTaskReportPayload / D16 agent_run 终态快照） */
export interface AgentTaskReport {
  run_id: string;
  kind: 'probe' | 'expert';
  status: 'done' | 'failed' | 'cancelled';
  session_id: string;
  parent_run_id?: string;
  title?: string;
  summary?: string;
  changed_files_count?: number;
  eta_actual_ms?: number;
}

/** 本端已上报的 run（近 5 分钟）：WS agent.task.completed 回流时自滤防双响 */
const reportedRuns = new Map<string, number>();
const REPORT_TTL_MS = 5 * 60 * 1000;

/** 上报前登记（本端负责本地通知，远端推送由其它端消费） */
export function markReportedRun(runId: string): void {
  reportedRuns.set(runId, Date.now());
}

/** 远端推送是否应抑制（本端刚上报过：本地通知已弹/工作台已实时展示） */
export function isLocallyReported(runId: string): boolean {
  const ts = reportedRuns.get(runId);
  if (!ts) return false;
  if (Date.now() - ts > REPORT_TTL_MS) {
    reportedRuns.delete(runId);
    return false;
  }
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * run 终态上报（尽力而为：重试 3 次 500ms/1s/2s 退避后放弃，不阻塞不打扰；
 * 非 Tauri 宿主（浏览器 dev/mock）不上报——服务端事件源只对真实宿主有意义）
 */
export async function reportAgentTask(p: AgentTaskReport): Promise<void> {
  markReportedRun(p.run_id);
  if (!isTauriAvailable()) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await http.post('/notify/agent-tasks', p);
      return;
    } catch {
      await sleep(500 * 2 ** attempt);
    }
  }
}
