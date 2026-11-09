/**
 * 本地完成通知（D16 P2 遗留-本地环：后台子任务/委派完成时，若工作台不可见
 * （非 /agent 路由或窗口最小化）弹系统通知；跨端 agent_done 待服务端事件源。
 * 降级：非 Tauri 宿主/权限拒绝/插件缺失一律静默。
 */

import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
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
