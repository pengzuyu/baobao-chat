/**
 * 用户面通讯录 API（M2，2026-11-12 用户裁决：通讯录结构全员可见——找人/看谁在用）：
 * - GET /org/tree 部门树（只读；与管理端 /admin/org/tree 同源 handler，无写径）
 * - GET /org/users 检索：含 uid（发起单聊 conv.create 需要；区别于预登录公开
 *   /auth/users 不含 uid 口径）；dept_id/ungrouped 支撑按部门浏览与虚拟「未分组」
 *   （未挂 user_dept 即命中——自助注册用户默认落此组，管理员挂部门后自动离开）
 * DeptNode 复用 admin 域类型（服务端同源结构）。
 */
import { http } from '../../../shared/api/http';
import type { DeptNode } from '../../admin/api/admin';

/** 通讯录行（登录后口径；uid=conv.create memberIds 数据源；dept_id=主部门，空=未挂→「未分组」） */
export interface DirectoryUser {
  uid: string;
  employee_no: string;
  display_name: string;
  org_path: string;
  dept_id?: string;
}

export interface DirectoryQuery {
  q?: string;
  /** 选中部门（'' = 全公司全量） */
  deptId?: string;
  /** 仅虚拟「未分组」成员 */
  ungrouped?: boolean;
  cursor?: string;
  limit?: number;
}

export async function fetchOrgTree(): Promise<DeptNode[]> {
  const data = await http.get<{ items: DeptNode[] }>('/org/tree');
  return data.items ?? [];
}

export async function fetchDirectoryUsers(
  query: DirectoryQuery,
): Promise<{ items: DirectoryUser[]; nextCursor: string }> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.deptId) params.set('dept_id', query.deptId);
  if (query.ungrouped) params.set('ungrouped', '1');
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const data = await http.get<{ items: DirectoryUser[]; next_cursor: string }>(`/org/users${suffix}`);
  return { items: data.items ?? [], nextCursor: data.next_cursor ?? '' };
}
