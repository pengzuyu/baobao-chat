/**
 * KB Query hooks（key 走 shared/api/keys.ts 工厂；摄入/重摄入后按前缀失效）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../../../shared/api/keys';
import {
  createDir,
  createSpace,
  fetchChunks,
  fetchJobs,
  fetchNodes,
  fetchOutline,
  fetchSpaces,
  ingestDoc,
  reingestDoc,
  type IngestPayload,
} from './kb';
import type { KbSpace } from '../model/types';

/** 可见空间列表（?type= 过滤） */
export function useSpaces(type: string = 'all') {
  return useQuery({
    queryKey: qk.kb.spaces(type),
    queryFn: () => fetchSpaces(type === 'all' ? undefined : type),
  });
}

/** 目录懒加载（子目录 + 目录下文档） */
export function useNodes(spaceId: string | null, parentId: string = '') {
  return useQuery({
    queryKey: qk.kb.nodes(spaceId ?? 'none', parentId),
    queryFn: () => fetchNodes(spaceId as string, parentId || undefined),
    enabled: !!spaceId,
  });
}

/** 文档分块（详情抽屉正文渲染） */
export function useChunks(docId: string | null) {
  return useQuery({
    queryKey: qk.kb.chunks(docId ?? 'none'),
    queryFn: () => fetchChunks(docId as string),
    enabled: !!docId,
  });
}

/** 文档大纲（heading 锚点） */
export function useOutline(docId: string | null) {
  return useQuery({
    queryKey: [...qk.kb.chunks(docId ?? 'none'), 'outline'],
    queryFn: () => fetchOutline(docId as string),
    enabled: !!docId,
  });
}

/** jobs 简版（docs 按 status 代） */
export function useJobs(spaceId: string | null, status: string = 'all') {
  return useQuery({
    queryKey: qk.kb.jobs(spaceId ?? 'none', status),
    queryFn: () => fetchJobs(spaceId as string, status === 'all' ? undefined : status),
    enabled: !!spaceId,
  });
}

/** 新建空间（成功后失效空间列表） */
export function useCreateSpace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ type, name }: { type: KbSpace['space_type']; name: string }) => createSpace(type, name),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['kb', 'spaces'] }),
  });
}

/** 新建目录（7014 内联提示由调用方捕获） */
export function useCreateDir(spaceId: string, parentId: string = '') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createDir(spaceId, name, parentId || undefined),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.kb.nodes(spaceId, parentId).slice(0, 3) }),
  });
}

/** 摄入（同步版：成功即终态；失败态文档也走 onSuccess 路径刷新列表） */
export function useIngest(spaceId: string, parentId: string = '') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: IngestPayload) => ingestDoc(spaceId, payload),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['kb', 'spaces'] });
      void qc.invalidateQueries({ queryKey: qk.kb.nodes(spaceId, parentId).slice(0, 3) });
      void qc.invalidateQueries({ queryKey: qk.kb.jobs(spaceId).slice(0, 3) });
    },
  });
}

/** 重摄入（version+1） */
export function useReingest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => reingestDoc(docId),
    onSettled: (_d, _e, docId) => {
      void qc.invalidateQueries({ queryKey: ['kb', 'spaces'] });
      void qc.invalidateQueries({ queryKey: qk.kb.doc(docId) });
      void qc.invalidateQueries({ queryKey: qk.kb.chunks(docId) });
      void qc.invalidateQueries({ queryKey: ['kb', 'nodes'] });
      void qc.invalidateQueries({ queryKey: ['kb', 'jobs'] });
    },
  });
}
