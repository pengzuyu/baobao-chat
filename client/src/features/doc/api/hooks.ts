/**
 * doc Query hooks（key 走 shared/api/keys.ts 工厂；写操作后精准失效：
 * 列表/详情/版本线/回收站按各自前缀，最近打开为 localStorage 派生态随操作同步）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../../../shared/api/keys';
import {
  createDocFile,
  fetchDocFile,
  fetchDocFiles,
  fetchDocTrash,
  fetchDocVersions,
  renameDocFile,
  restoreDocFromTrash,
  restoreDocVersion,
  saveDocContent,
  trashDocFile,
} from './doc';

/** 文档列表（q 模糊；首屏一页 50，翻页走 fetchNextPage 形态由页面按需接——v0.1 单页够用） */
export function useDocFiles(q: string = '') {
  return useQuery({
    queryKey: qk.doc.files(q),
    queryFn: () => fetchDocFiles(q),
  });
}

/** 文档详情（含当前正文） */
export function useDocFile(docId: string | null) {
  return useQuery({
    queryKey: qk.doc.file(docId ?? 'none'),
    queryFn: () => fetchDocFile(docId as string),
    enabled: !!docId,
  });
}

/** 版本时间线（version 倒序） */
export function useDocVersions(docId: string | null) {
  return useQuery({
    queryKey: qk.doc.versions(docId ?? 'none'),
    queryFn: () => fetchDocVersions(docId as string),
    enabled: !!docId,
  });
}

/** 回收站列表 */
export function useDocTrash() {
  return useQuery({
    queryKey: qk.doc.trash,
    queryFn: () => fetchDocTrash(),
  });
}

/** 失效文档域相关缓存（写操作收尾共用） */
function useInvalidateDoc() {
  const qc = useQueryClient();
  return (docId?: string) => {
    void qc.invalidateQueries({ queryKey: ['doc', 'files'] });
    void qc.invalidateQueries({ queryKey: ['doc', 'trash'] });
    if (docId) {
      void qc.invalidateQueries({ queryKey: qk.doc.file(docId) });
      void qc.invalidateQueries({ queryKey: qk.doc.versions(docId) });
    }
  };
}

/** 新建文档（成功后失效列表） */
export function useCreateDoc() {
  const invalidate = useInvalidateDoc();
  return useMutation({
    mutationFn: (title: string) => createDocFile(title),
    onSuccess: () => invalidate(),
  });
}

/** 重命名（6015 同名由调用方捕获内联提示） */
export function useRenameDoc() {
  const invalidate = useInvalidateDoc();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameDocFile(id, title),
    onSuccess: (d) => invalidate(d.id),
  });
}

/** 移入回收站（toast 由调用方） */
export function useTrashDoc() {
  const invalidate = useInvalidateDoc();
  return useMutation({
    mutationFn: (id: string) => trashDocFile(id),
    onSuccess: (d) => invalidate(d.id),
  });
}

/** 乐观锁保存（6004 冲突由调用方捕获渲染红条；错误不吞——useMutation error 态） */
export function useSaveDocContent() {
  const invalidate = useInvalidateDoc();
  return useMutation({
    mutationFn: ({ id, baseVersion, contentMd }: { id: string; baseVersion: number; contentMd: string }) =>
      saveDocContent(id, baseVersion, contentMd),
    onSuccess: (r) => invalidate(r.file.id),
  });
}

/** 恢复目标版本（成功后详情+版本线+列表全失效） */
export function useRestoreDocVersion() {
  const invalidate = useInvalidateDoc();
  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) => restoreDocVersion(id, version),
    onSuccess: (r) => invalidate(r.file.id),
  });
}

/** 回收站恢复（同名 renamed 由调用方 toast 新名） */
export function useRestoreDocFromTrash() {
  const invalidate = useInvalidateDoc();
  return useMutation({
    mutationFn: (id: string) => restoreDocFromTrash(id),
    onSuccess: (r) => invalidate(r.file.id),
  });
}
