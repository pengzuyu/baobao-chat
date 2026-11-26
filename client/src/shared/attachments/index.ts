/**
 * Agent 附件共享层（2026-11-26）：工作台与聊天页机器人模式共用的附件能力。
 *
 * - 类型：AttachmentMeta（壳侧 agent_attach_stat 产出）/ PendingAttachment（待发区）；
 * - bridge：文件选择（plugin-dialog 多选）/ 粘贴图片落盘 / 元数据 / Finder 定位；
 * - hooks：useFileDrop（Tauri 原生拖拽事件——窗口 dragDropEnabled 缺省 true，
 *   HTML5 onDrop 不触发，必须走 onDragDropEvent）+ useImagePaste（剪贴板图片）。
 *
 * 纯浏览器 dev/preview 下 invoke 不可用：选择/粘贴入口 try/catch 提示（附件是
 * 壳功能，mock 桥不提供剧本）。
 */

import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

/** 附件元数据（壳 agent_attach_stat 返回项；协议 Attachment 的前端镜像） */
export interface AttachmentMeta {
  path: string;
  name: string;
  size: number;
  kind: 'image' | 'file';
}

/** 协议附件（sendMessage payload；camelCase 与 RT Attachment 同构） */
export type AttachmentPayload = AttachmentMeta & { mime?: string };

/** 每条消息附件上限（壳侧同步校验） */
export const MAX_ATTACHMENTS = 20;
/** 单文件上限（MB，壳侧同步校验） */
export const MAX_FILE_MB = 100;

/** 文件选择对话框（多选；返回本机绝对路径） */
export async function pickAttachmentPaths(): Promise<string[]> {
  const picked = await open({ multiple: true, title: '选择要发送给 Agent 的文件' });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

/** 批量取元数据（存在性/大小/图片判定都在壳侧做，异常外抛给调用方提示） */
export async function statAttachments(paths: string[]): Promise<AttachmentMeta[]> {
  const rep = await invoke<{ items: AttachmentMeta[] }>('agent_attach_stat', { paths });
  return rep.items;
}

/** 本地图片 asset URL（缩略图/预览渲染；需壳侧已授权——发送/粘贴路径已登记） */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

/** 在文件管理器中定位 */
export async function revealPath(path: string): Promise<void> {
  await invoke('sys_reveal_path', { path });
}

/** 剪贴板图片落盘（写入用户工作空间 inbox/，返回本机路径） */
export async function savePastedImage(bytes: Uint8Array): Promise<string> {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const b64 = btoa(binary);
  const rep = await invoke<{ path: string }>('agent_paste_image', { dataBase64: b64 });
  return rep.path;
}

/** 文件大小人性化（format.ts 单源补充：附件场景内聚，避免跨域 import 泛化） */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
