/**
 * 表情包 API（0022 自定义表情包）：
 * - 库：GET /stickers（我的集+启用公共集，items 内联）
 * - 个人集：建集/加图/删图/删集；公共集治理走 /admin/stickers/*（管理端页面用）
 * - 发送：msg.send type=sticker body{sticker_id,file_id}（服务端双校验）
 */

import { http } from '../../../shared/api/http';
import { wsClient } from '../../../shared/api/ws';
import type { SendAck } from '../model/types';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK !== '0';

export interface StickerItem {
  id: string;
  fileId: string;
  name?: string;
}

export interface StickerSet {
  id: string;
  name: string;
  isPublic: boolean;
  status: number;
  items: StickerItem[];
}

export interface StickerLibrary {
  mine: StickerSet[];
  public: StickerSet[];
}

/** 表情库（面板打开时拉取一次） */
export async function fetchStickerLibrary(): Promise<StickerLibrary> {
  if (USE_MOCK) return { mine: [], public: [] };
  return http.get<StickerLibrary>('/stickers');
}

/** 建个人集（≤10 个/人） */
export async function createStickerSet(name: string): Promise<StickerSet> {
  if (USE_MOCK) throw new Error('mock 模式不支持');
  return http.post<StickerSet>('/stickers/sets', { name });
}

/** 个人集加图（file_id 来自 /files/upload；同集同图去重） */
export async function addStickerItem(setId: string, fileId: string, name?: string): Promise<StickerItem> {
  if (USE_MOCK) throw new Error('mock 模式不支持');
  return http.post<StickerItem>('/stickers/items', { set_id: setId, file_id: fileId, name });
}

/** 删个人表情 */
export async function removeStickerItem(itemId: string): Promise<void> {
  if (USE_MOCK) return;
  await http.delete(`/stickers/items/${encodeURIComponent(itemId)}`);
}

/** 删个人集（连带条目） */
export async function removeStickerSet(setId: string): Promise<void> {
  if (USE_MOCK) return;
  await http.delete(`/stickers/sets/${encodeURIComponent(setId)}`);
}

/** 发送表情消息（点击面板表情即发；服务端校验可见性+file 一致） */
export function sendStickerMessage(convId: string, item: StickerItem): Promise<SendAck> {
  return wsClient.request<SendAck>('msg.send', {
    conv_id: convId,
    client_msg_id: crypto.randomUUID(),
    type: 'sticker',
    body: { sticker_id: item.id, file_id: item.fileId },
  });
}

// ── 管理端（公共集治理；admin:policy:manage 守卫）──

/** 全量公共集（含下架；管理端列表） */
export async function fetchAdminStickerSets(): Promise<StickerSet[]> {
  if (USE_MOCK) return [];
  const data = await http.get<{ items: StickerSet[] }>('/admin/stickers/sets');
  return data.items;
}

export async function createAdminStickerSet(name: string): Promise<StickerSet> {
  return http.post<StickerSet>('/admin/stickers/sets', { name });
}

export async function addAdminStickerItem(setId: string, fileId: string, name?: string): Promise<StickerItem> {
  return http.post<StickerItem>(`/admin/stickers/sets/${encodeURIComponent(setId)}/items`, {
    set_id: setId,
    file_id: fileId,
    name,
  });
}

export async function setAdminStickerStatus(setId: string, status: 1 | 2): Promise<void> {
  await http.patch(`/admin/stickers/sets/${encodeURIComponent(setId)}/status`, { status });
}

export async function removeAdminStickerSet(setId: string): Promise<void> {
  await http.delete(`/admin/stickers/sets/${encodeURIComponent(setId)}`);
}
