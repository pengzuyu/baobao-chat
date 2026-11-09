/**
 * 知识库域类型（D07 阶段一务实版；与服务端 kbapi DTO 同构——snake_case 直传，
 * 免二次映射，登记）。
 */

/** 空间类型（11 §2.1 三级） */
export type SpaceType = 'personal' | 'dept' | 'company';

/** 文档来源（v0.1 三态：粘贴文本 / 文件引用 / markdown 文本） */
export type SourceType = 'text' | 'file' | 'markdown';

/** 摄入状态（同步版三态；pending/parsing/embedding 细分随阶段二 job 表） */
export type DocStatus = 'processing' | 'ready' | 'failed';

/** 空间（GET /kb/spaces 列表项） */
export interface KbSpace {
  id: string;
  space_type: SpaceType;
  name: string;
  owner_id: string;
  quota_bytes: number;
  used_bytes: number;
  doc_count: number;
  created_at: number;
}

/** 目录（nodes 列表/新建） */
export interface KbNode {
  id: string;
  space_id: string;
  parent_id: string;
  name: string;
  created_at: number;
}

/** 文档（摄入响应/列表项/详情） */
export interface KbDoc {
  id: string;
  space_id: string;
  node_id: string;
  title: string;
  source_type: SourceType;
  source_ref: string;
  ext: string;
  size: number;
  status: DocStatus;
  error_msg?: string;
  version: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

/** nodes 懒加载响应（子目录 + 目录下文档） */
export interface KbNodeChildren {
  dirs: KbNode[];
  docs: KbDoc[];
}

/** 分块（chunks 列表/上下文展开） */
export interface KbChunk {
  seq: number;
  heading_path: string;
  content: string;
  token_count: number;
}

/** 大纲锚点（chunks?outline=1） */
export interface KbOutlineItem {
  heading_path: string;
  seq: number;
}

/** POST /kb/query 请求 */
export interface KbQueryReq {
  space_ids?: string[];
  keyword: string;
  top_k?: number;
}

/** 检索命中项（highlight 为 snippet 内的码点偏移区间） */
export interface KbQueryHit {
  doc_id: string;
  title: string;
  space_id: string;
  space_type: SpaceType;
  chunk_seq: number;
  heading_path: string;
  snippet: string;
  highlight?: Array<[number, number]>;
  score: number;
}

/** POST /kb/query 响应 */
export interface KbQueryResp {
  items: KbQueryHit[];
  took_ms: number;
  degraded?: string[]; // 'vector'=向量路降级（仅关键词）
  filtered_hint?: string; // OQ-D10 合规提示："部分结果被策略隐藏"（存在不可见空间时）
}
