/**
 * 管理域 Query/Mutation hooks（key 走 shared/api/keys.ts qk.admin 工厂）。
 * 仪表盘 60s 轮询（页面可见时）；写操作（禁用/启用/词库增删）成功后按前缀失效
 * 用户列表 + 审计时间线（后端自动记审计）。
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../../../shared/api/keys';
import {
  addWord,
  createAIProvider,
  deleteAIProvider,
  deleteWord,
  fetchAgentPolicy,
  fetchAIProviders,
  fetchAIRoutes,
  fetchAudit,
  fetchDashboard,
  fetchUsage,
  fetchUsers,
  fetchWords,
  patchUserStatus,
  postUserStatus,
  putAIRoutes,
  updateAIProvider,
} from './admin';
import type { AdminUserStatus, AIProviderInput, AIRouteRule } from '../model/types';

/** 仪表盘（PAD-02：60s 轮询） */
export function useDashboard() {
  return useQuery({
    queryKey: qk.admin.dashboard,
    queryFn: fetchDashboard,
    refetchInterval: 60_000,
  });
}

/** 用户列表（keyword/status 过滤 + cursor 无限翻页——"加载更多"拼页） */
export function useUsers(keyword: string, status: number) {
  return useInfiniteQuery({
    queryKey: qk.admin.users(keyword, status),
    queryFn: ({ pageParam }) =>
      fetchUsers({ keyword: keyword || undefined, status: status || undefined, cursor: pageParam || undefined }),
    initialPageParam: '',
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? last.next_cursor : undefined),
  });
}

/** 禁用/启用（语义端点；成功后失效用户列表+审计+仪表盘在线数） */
export function useUserStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, action }: { userId: string; action: 'disable' | 'enable' }) => postUserStatus(userId, action),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
      void qc.invalidateQueries({ queryKey: qk.admin.dashboard });
    },
  });
}

/** 用户状态 PATCH 形态（与语义端点等价；列表行内切换用） */
export function useUserPatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, status }: { userId: string; status: AdminUserStatus }) => patchUserStatus(userId, status),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}

/** Agent 工具策略只读快照 */
export function useAgentPolicy() {
  return useQuery({
    queryKey: qk.admin.agentPolicy,
    queryFn: fetchAgentPolicy,
  });
}

/** 敏感词分页列表（cursor 无限翻页） */
export function useWords() {
  return useInfiniteQuery({
    queryKey: qk.admin.words(),
    queryFn: ({ pageParam }) => fetchWords({ cursor: pageParam || undefined }),
    initialPageParam: '',
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? last.next_cursor : undefined),
  });
}

/** 新增敏感词（9001 重复词内联提示由调用方捕获） */
export function useAddWord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ word, category }: { word: string; category?: string }) => addWord(word, category),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'words'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}

/** 删除敏感词 */
export function useDeleteWord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWord(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'words'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}

/** AI 用量汇总（days 缺省 7） */
export function useUsage(days = 7) {
  return useQuery({
    queryKey: qk.admin.usage(days),
    queryFn: () => fetchUsage(days),
  });
}

/** 审计时间线（cursor 无限翻页——"加载更多"拼页） */
export function useAudit() {
  return useInfiniteQuery({
    queryKey: qk.admin.audit(),
    queryFn: ({ pageParam }) => fetchAudit({ cursor: pageParam || undefined }),
    initialPageParam: '',
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? last.next_cursor : undefined),
  });
}

/* ── AI 供应商治理（0023）── */

/** 公司级供应商列表 */
export function useAIProviders() {
  return useQuery({ queryKey: qk.admin.aiProviders, queryFn: () => fetchAIProviders() });
}

/** 创建/更新/删除（成功后失效供应商与路由——删引用方需路由重算） */
export function useSaveAIProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: AIProviderInput }) =>
      id ? updateAIProvider(id, input) : createAIProvider(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'aiProviders'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'aiRoutes'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}

export function useDeleteAIProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAIProvider(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'aiProviders'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'aiRoutes'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}

/** 默认档路由（主备 + embed/rerank 可选档） */
export function useAIRoutes() {
  return useQuery({ queryKey: qk.admin.aiRoutes, queryFn: fetchAIRoutes });
}

export function usePutAIRoutes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: AIRouteRule[]) => putAIRoutes(items),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'aiRoutes'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}
