/**
 * 完成通知双档（D16 P1-6 + 14 篇 §3.3 OQ-C32）：
 * - 本地档：工作台不可见（非 /agent 路由或窗口最小化）弹系统通知；
 * - 跨端档：run 终态上报服务端 notify 域（POST /notify/agent-tasks）→
 *   agent.task.completed 推其它在线设备 + 通知中心落卡（kind=agent_done）。
 * 降级：非 Tauri 宿主/权限拒绝/插件缺失/上报失败一律静默（通知是增益不是依赖）。
 */

import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { http } from '../../../shared/api/http';
import { isTauriAvailable } from './tauri';

/** 工作台是否可见（路由在 agent 域且页面未隐藏） */
export function workbenchVisible(): boolean {
  if (typeof document !== 'undefined' && document.hidden) return false;
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/agent');
}

/** 弹系统通知（懒申请权限；任何失败静默降级——通知是增益不是依赖） */
export async function notifyAgentDone(title: string, body: string): Promise<void> {
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

// ── 跨端档：run 终态上报（14 篇 §3.3；服务端幂等键 run_id+status，重试安全）──

/** 上报体（snake，对齐服务端 AgentTaskReportPayload / D16 agent_run 终态快照） */
export interface AgentTaskReport {
  run_id: string;
  kind: 'probe' | 'expert' | 'team' | 'delegate';
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
