/**
 * 文档中心核心类型（D05 §6.3 子集；阶段一务实版——markdown 原生文档）。
 * 与服务端 docapi DTO 字段同源（camel/snake 以 REST 实际返回为准）。
 */

/** 文档行（列表项/详情；content_md 仅详情与保存响应携带） */
export interface DocFile {
  id: string;
  owner_id: string;
  title: string;
  folder_id: string;
  /** v0.1 恒 personal（space 域阶段二） */
  scope: 'personal' | string;
  /** 1 正常 / 2 回收站 */
  status: 1 | 2;
  /** ms；回收站态携带（到期自动彻底删除，06 §4.7） */
  purge_at?: number;
  current_version: number;
  /** 当前正文冗余（详情携带；列表省略） */
  content_md?: string;
  created_at: number;
  updated_at: number;
}

/** 版本时间线条目（v0.1 三态：create|manual|restore；auto/close/import 阶段二） */
export interface DocVersion {
  id: string;
  doc_id: string;
  version: number;
  editor_id: string;
  snapshot_type: 'create' | 'manual' | 'restore' | string;
  note?: string;
  created_at: number;
}

/** 列表响应（键集翻页 next_cursor="<ms>-<id>"，空=末页） */
export interface DocListResp {
  items: DocFile[];
  next_cursor: string;
  has_more: boolean;
}

/** 版本时间线响应（version 倒序） */
export interface VersionListResp {
  items: DocVersion[];
  next_cursor: string;
  has_more: boolean;
}

/** PUT content 响应（保存成功回执；next_version=客户端重置后的 base_version） */
export interface SaveContentResp {
  file: DocFile;
  version: DocVersion;
  next_version: number;
}

/** 恢复响应（版本恢复/回收站恢复共用骨架） */
export interface RestoreResp {
  file: DocFile;
  new_version_no: number;
  /** 同名冲突自动" (恢复)"后缀（回收站恢复） */
  renamed: boolean;
}

/** 分享占位响应（v0.1：一次性 share_id + 7d；假 URL——外链页阶段二） */
export interface ShareResp {
  share_id: string;
  url: string;
  expires_at: number;
  note: string;
}

/** 最近打开条目（localStorage LRU ≤20；D05 §6.2 local_doc_recent 的 v0.1 简版） */
export interface DocRecentEntry {
  id: string;
  title: string;
  version: number;
  at: number;
}
