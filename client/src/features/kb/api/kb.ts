/**
 * 知识库域 API 封装（D07 阶段一务实版，REST 10 项）：
 * - 空间：列表（?type= 过滤）/ 新建（dept|company；personal 惰性创建）
 * - 目录：nodes 懒加载（?parent_id=）/ 新建（7014 同名）
 * - 摄入：文本粘贴 / 文件引用（file_id 先经 D06 /files/upload 上传）
 * - 文档：详情 / 分块（outline|around|全量）/ 重摄入
 * - 检索：POST /kb/query（RRF 融合结果卡数据源）
 * mock 桩集中本文件（默认真实 REST，显式 VITE_USE_MOCK=1 才启用——D18 翻转）。
 */

import { http } from '../../../shared/api/http';
import type { KbChunk, KbDoc, KbNode, KbNodeChildren, KbOutlineItem, KbQueryHit, KbQueryReq, KbQueryResp, KbSpace } from '../model/types';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === '1';

/** 可见空间列表（个人空间首访惰性创建） */
export async function fetchSpaces(type?: string): Promise<KbSpace[]> {
  if (USE_MOCK) return mockSpaces().filter((s) => !type || s.space_type === type);
  const data = await http.get<{ items: KbSpace[] }>(`/kb/spaces${type ? `?type=${encodeURIComponent(type)}` : ''}`);
  return data.items;
}

/** 目录懒加载（parent_id 空=空间根：子目录 + 目录下文档） */
export async function fetchNodes(spaceId: string, parentId?: string): Promise<KbNodeChildren> {
  if (USE_MOCK) return { dirs: [], docs: mockDocs() };
  const q = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : '';
  return http.get<KbNodeChildren>(`/kb/spaces/${encodeURIComponent(spaceId)}/nodes${q}`);
}

/** 新建目录（7014 同名冲突） */
export async function createDir(spaceId: string, name: string, parentId?: string): Promise<KbNode> {
  if (USE_MOCK) return { id: `mock-node-${Date.now()}`, space_id: spaceId, parent_id: parentId ?? '', name, created_at: Date.now() };
  return http.post<KbNode>(`/kb/spaces/${encodeURIComponent(spaceId)}/nodes`, { name, parent_id: parentId });
}

/** 摄入请求体（text 与 file_id 二选一；同步版——返回即终态 ready/failed） */
export interface IngestPayload {
  title?: string;
  text?: string;
  format?: 'text' | 'markdown';
  file_id?: string;
  node_id?: string;
}

/** 摄入文档（同步管线：清洗分段→嵌入→落库；失败返回 failed+error_msg 文档） */
export async function ingestDoc(spaceId: string, payload: IngestPayload): Promise<KbDoc> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 600));
    const text = payload.text ?? 'mock 文件内容';
    return {
      id: `mock-doc-${Date.now()}`, space_id: spaceId, node_id: payload.node_id ?? '',
      title: payload.title || 'mock 文档', source_type: payload.file_id ? 'file' : payload.format ?? 'text',
      source_ref: payload.file_id ?? '', ext: payload.file_id ? 'md' : 'txt', size: text.length,
      status: 'ready', version: 1, created_by: 'u-1001', created_at: Date.now(), updated_at: Date.now(),
    };
  }
  const body: Record<string, unknown> = {};
  if (payload.title) body.title = payload.title;
  if (payload.text !== undefined) body.text = payload.text;
  if (payload.format) body.format = payload.format;
  if (payload.file_id) body.file_id = Number(payload.file_id);
  if (payload.node_id) body.node_id = Number(payload.node_id);
  return http.post<KbDoc>(`/kb/spaces/${encodeURIComponent(spaceId)}/docs`, body);
}

/** 文档详情 */
export async function fetchDoc(docId: string): Promise<KbDoc> {
  if (USE_MOCK) return { ...mockDocs()[0], id: docId };
  return http.get<KbDoc>(`/kb/docs/${encodeURIComponent(docId)}`);
}

/** 分块全量（seq 升序） */
export async function fetchChunks(docId: string): Promise<KbChunk[]> {
  if (USE_MOCK) return mockChunks();
  const data = await http.get<{ items: KbChunk[] }>(`/kb/docs/${encodeURIComponent(docId)}/chunks`);
  return data.items;
}


/** 大纲锚点 */
export async function fetchOutline(docId: string): Promise<KbOutlineItem[]> {
  if (USE_MOCK) return [{ heading_path: '总则', seq: 1 }];
  const data = await http.get<{ items: KbOutlineItem[] }>(`/kb/docs/${encodeURIComponent(docId)}/chunks?outline=1`);
  return data.items;
}

/** 上下文展开（seq 前后各 1 块，INT-KB-14） */
export async function fetchChunksAround(docId: string, seq: number): Promise<KbChunk[]> {
  if (USE_MOCK) return mockChunks();
  const data = await http.get<{ items: KbChunk[] }>(`/kb/docs/${encodeURIComponent(docId)}/chunks?around=${seq}`);
  return data.items;
}

/** 重摄入（version+1；file 来源重读） */
export async function reingestDoc(docId: string): Promise<KbDoc> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 500));
    return { ...mockDocs()[0], id: docId, version: 2 };
  }
  return http.post<KbDoc>(`/kb/docs/${encodeURIComponent(docId)}/reingest`);
}

/** 混合检索（keyword 必填；向量+关键词 RRF 融合） */
export async function queryKb(req: KbQueryReq): Promise<KbQueryResp> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 400));
    const kw = req.keyword.trim();
    const items: KbQueryHit[] = mockChunks()
      .filter((c) => c.content.includes(kw))
      .slice(0, req.top_k ?? 10)
      .map((c, i) => {
        const at = c.content.indexOf(kw);
        return {
          doc_id: 'mock-doc-1', title: 'mock 登录安全规范', space_id: 'mock-sp-1', space_type: 'personal',
          chunk_seq: c.seq, heading_path: c.heading_path, snippet: c.content,
          highlight: at >= 0 ? ([[at, at + kw.length]] as Array<[number, number]>) : undefined,
          score: 1 / (60 + i + 1),
        };
      });
    return { items, took_ms: 42 };
  }
  return http.post<KbQueryResp>('/kb/query', req);
}

/** jobs 简版（docs 按 status 列表代；?status= 过滤） */
export async function fetchJobs(spaceId: string, status?: string): Promise<KbDoc[]> {
  if (USE_MOCK) return mockDocs().filter((d) => !status || d.status === status);
  const q = `space_id=${encodeURIComponent(spaceId)}${status ? `&status=${encodeURIComponent(status)}` : ''}`;
  const data = await http.get<{ items: KbDoc[] }>(`/kb/jobs?${q}`);
  return data.items;
}

// ── mock 桩（六态走查用；不散落组件） ──

function mockSpaces(): KbSpace[] {
  return [
    { id: 'mock-sp-1', space_type: 'personal', name: '我的知识库', owner_id: 'u-1001', quota_bytes: 5 << 30, used_bytes: 128 << 10, doc_count: 2, created_at: Date.now() - 86400_000 },
    { id: 'mock-sp-2', space_type: 'company', name: '全公司知识库', owner_id: 'u-1001', quota_bytes: 20 << 30, used_bytes: 3 << 20, doc_count: 12, created_at: Date.now() - 3600_000 },
  ];
}

function mockDocs(): KbDoc[] {
  return [
    {
      id: 'mock-doc-1', space_id: 'mock-sp-1', node_id: '', title: '登录安全规范', source_type: 'markdown',
      source_ref: '', ext: 'md', size: 2048, status: 'ready', version: 1, created_by: 'u-1001',
      created_at: Date.now() - 7200_000, updated_at: Date.now() - 3600_000,
    },
    {
      id: 'mock-doc-2', space_id: 'mock-sp-1', node_id: '', title: 'Q3 复盘要点', source_type: 'text',
      source_ref: '', ext: 'txt', size: 1024, status: 'processing', version: 1, created_by: 'u-1001',
      created_at: Date.now() - 600_000, updated_at: Date.now() - 300_000,
    },
  ];
}

function mockChunks(): Array<{ seq: number; heading_path: string; content: string; token_count: number }> {
  return [
    { seq: 1, heading_path: '登录安全规范', content: '# 登录安全规范\n当令牌过期时客户端应静默刷新并重试请求。', token_count: 30 },
    { seq: 2, heading_path: '登录安全规范', content: '连续失败则强制重新登录，并在审计日志中登记。', token_count: 22 },
  ];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── D24 博客化：浏览量/榜单/我的 ──

import type { KbMeSummary, KbMyDocsResp, KbRankingsResp, KbViewResp } from '../model/types';

/** 浏览上报（日去重+作者本人不计；打开阅读页即调） */
export async function viewDoc(docId: string): Promise<KbViewResp> {
  if (USE_MOCK) {
    await delay(80);
    return { view_count: 42 };
  }
  return http.post<KbViewResp>(`/kb/docs/${encodeURIComponent(docId)}/view`);
}

/** 个人概览（首页概览卡） */
export async function fetchMySummary(): Promise<KbMeSummary> {
  if (USE_MOCK) {
    await delay(150);
    return { doc_count: 6, month_new: 2, total_views: 1284, views_7d: 86, author_rank: 3 };
  }
  return http.get<KbMeSummary>('/kb/me/summary');
}

/** 我的全部文章（两维度，cursor 翻页） */
export async function fetchMyDocs(cursor?: string, limit?: number): Promise<KbMyDocsResp> {
  if (USE_MOCK) {
    await delay(150);
    return { items: mockDocs().map((d) => ({ ...d, view_count: 12, space_type: 'personal' as const })) };
  }
  const q = new URLSearchParams();
  if (cursor) q.set('cursor', cursor);
  if (limit) q.set('limit', String(limit));
  const qs = q.toString();
  return http.get<KbMyDocsResp>(`/kb/me/docs${qs ? `?${qs}` : ''}`);
}

/** 榜单（board=latest|hot|authors；window=7d|30d|all 仅 hot；仅公共维度） */
export async function fetchRankings(board: 'latest' | 'hot' | 'authors', window?: '7d' | '30d' | 'all'): Promise<KbRankingsResp> {
  if (USE_MOCK) {
    await delay(200);
    if (board === 'authors') {
      return {
        board,
        authors: [
          { rank: 1, user_id: 'u-1002', user_name: '李四', doc_count: 32, total_views: 8921 },
          { rank: 2, user_id: 'u-1001', user_name: '张三', doc_count: 23, total_views: 1204 },
        ],
      };
    }
    return {
      board,
      window,
      docs: mockDocs().map((d, i) => ({
        doc_id: d.id, title: d.title, user_id: 'u-1001', user_name: '张三',
        node_name: i === 0 ? '技术分享' : '', view_count: 42 + i, hot: board === 'hot' ? 42 - i * 10 : 0,
        created_at: d.created_at,
      })),
    };
  }
  const q = new URLSearchParams({ board });
  if (window) q.set('window', window);
  return http.get<KbRankingsResp>(`/kb/rankings?${q.toString()}`);
}

/** IM 消息存入知识库（N6：space_id 空=默认落我的笔记；返回终态文章） */
export async function ingestFromIm(req: { msg_id: string; text: string; title?: string; space_id?: string }): Promise<KbDoc> {
  if (USE_MOCK) {
    await delay(500);
    return {
      id: `mock-doc-${Date.now()}`, space_id: 'mock-sp-1', node_id: '', title: req.title || 'IM 消息',
      source_type: 'im', source_ref: req.msg_id, ext: 'txt', size: req.text.length, status: 'ready',
      version: 1, view_count: 0, space_type: 'personal', created_by: 'u-1001', created_at: Date.now(), updated_at: Date.now(),
    };
  }
  const body: Record<string, unknown> = { msg_id: Number(req.msg_id), text: req.text };
  if (req.title) body.title = req.title;
  if (req.space_id) body.space_id = Number(req.space_id);
  return http.post<KbDoc>('/kb/docs/from-im', body);
}
