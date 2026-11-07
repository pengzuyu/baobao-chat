// 邮件域 react-query 钩子（key 走 qk.mail 集中工厂）
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../../../shared/api/keys';
import * as api from './mail';
import type { MailSettings, SendMailReq } from '../model/types';

export function useMailSummary() {
  return useQuery({ queryKey: qk.mail.summary, queryFn: api.fetchSummary });
}

export function useMailMessages(folder: string, filter = '') {
  return useQuery({
    queryKey: qk.mail.messages(folder, filter),
    queryFn: () => api.fetchMessages(folder, filter),
  });
}

export function useMailMessage(id: string | null) {
  return useQuery({
    queryKey: qk.mail.message(id ?? ''),
    queryFn: () => api.fetchMessage(id as string),
    enabled: !!id,
  });
}

export function useMailSearch(q: string, attachOnly = false) {
  return useQuery({
    queryKey: qk.mail.search(q, attachOnly),
    queryFn: () => api.searchMail(q, attachOnly),
    enabled: q.trim().length > 0,
  });
}

export function useMailSettings() {
  return useQuery({ queryKey: qk.mail.settings, queryFn: api.fetchSettings });
}

export function useUpdateMailSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (set: MailSettings) => api.updateSettings(set),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.mail.settings }),
  });
}

export function useAppPasswords() {
  return useQuery({ queryKey: qk.mail.appPasswords, queryFn: api.fetchAppPasswords });
}

export function useCreateAppPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createAppPassword(name),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.mail.appPasswords }),
  });
}

export function useRevokeAppPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeAppPassword(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.mail.appPasswords }),
  });
}

export function useSharedMailboxes() {
  return useQuery({ queryKey: qk.mail.shared, queryFn: api.fetchSharedMailboxes });
}

export function useSharedMessages(mailboxId: string | null, folder = 'inbox') {
  return useQuery({
    queryKey: qk.mail.sharedMessages(mailboxId ?? '', folder),
    queryFn: () => api.fetchSharedMessages(mailboxId as string, folder),
    enabled: !!mailboxId,
  });
}

export function useSendMail(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: SendMailReq) => api.sendMail(req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mail'] });
      onDone?.();
    },
  });
}

export function useSendAsShared(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ mailboxId, req }: { mailboxId: string; req: SendMailReq }) =>
      api.sendAsShared(mailboxId, req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mail'] });
      onDone?.();
    },
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.markRead(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['mail'] }),
  });
}

export function useSetStar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api.setStar(id, on),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['mail'] }),
  });
}

export function useMoveMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, folder }: { id: string; folder: string }) => api.moveMessage(id, folder),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['mail'] }),
  });
}
