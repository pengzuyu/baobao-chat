/**
 * 稳定设备号（D28 批0/Q0-3）：Rust 侧持久化 uuid 单源供给；浏览器环境（mock 走查）回退会话级常量。
 * 消费方：登录/refresh 的 did 绑定、WS 连接认证——替换既有 'dev-device' 硬编码（App.tsx TODO）。
 */

let cached: string | null = null;

function isTauriHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function ensureDeviceId(): Promise<string> {
  if (cached) return cached;
  if (isTauriHost()) {
    const { invoke } = await import('@tauri-apps/api/core');
    cached = await invoke<string>('device_id');
  } else {
    cached = 'web-session';
  }
  return cached;
}

/** 同步读取（ensureDeviceId 未完成时为 null——仅在已初始化路径使用） */
export function getDeviceId(): string | null {
  return cached;
}
