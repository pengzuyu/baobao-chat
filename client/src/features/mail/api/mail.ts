/**
 * 邮件域 API（22 §6.1 REST 契约；mock 桩集中本文件底部——不散落组件）。
 * 默认连真服务；显式 VITE_USE_MOCK=1 才走桩（D18 翻转）。
 */
import { http } from '../../../shared/api/http';
import type {
  AppPasswordPlain,
  AppPasswordView,
  MailMessage,
  MailSettings,
  MailSummary,
  SendMailReq,
  SendMailResp,
  SharedMailboxView,
} from '../model/types';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === '1';

export async function fetchSummary(): Promise<MailSummary> {
  if (USE_MOCK) return mockSummary();
  return http.get<MailSummary>('/mail/summary');
}

export async function fetchMessages(
  folder: string,
  filter: string = '',
  cursor?: string | null,
  limit = 50,
): Promise<MailMessage[]> {
  if (USE_MOCK) return mockMessages(folder, filter);
  const params = new URLSearchParams({ folder, limit: String(limit) });
  if (filter) params.set('filter', filter);
  if (cursor) params.set('cursor', cursor);
  const data = await http.get<MailMessage[]>(`/mail/messages?${params}`);
  return data ?? [];
}

export async function fetchMessage(id: string): Promise<MailMessage> {
  if (USE_MOCK) return mockMessageDetail(id);
  return http.get<MailMessage>(`/mail/messages/${id}`);
}

export async function sendMail(req: SendMailReq): Promise<SendMailResp> {
  if (USE_MOCK) {
    return { message_id: `mock-${Date.now()}`, delivered: req.to, undelivered: [] };
  }
  return http.post<SendMailResp>('/mail/messages', req);
}

export async function markRead(id: string): Promise<void> {
  if (USE_MOCK) return;
  await http.post(`/mail/messages/${id}/read`, {});
}

export async function setStar(id: string, on: boolean): Promise<void> {
  if (USE_MOCK) return;
  await http.post(`/mail/messages/${id}/star`, { on });
}

export async function moveMessage(id: string, folder: string): Promise<void> {
  if (USE_MOCK) return;
  await http.post(`/mail/messages/${id}/move`, { folder });
}

export async function searchMail(q: string, attachOnly = false, limit = 50): Promise<MailMessage[]> {
  if (USE_MOCK) return mockMessages('inbox', attachOnly ? 'attach' : '').filter((m) =>
    q ? m.subject.includes(q) || m.from_addr.includes(q) : true,
  );
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (attachOnly) params.set('attach', '1');
  const data = await http.get<MailMessage[]>(`/mail/search?${params}`);
  return data ?? [];
}

export async function fetchSettings(): Promise<MailSettings> {
  if (USE_MOCK) return { ...mockSettings };
  return http.get<MailSettings>('/mail/settings');
}

export async function updateSettings(set: MailSettings): Promise<void> {
  if (USE_MOCK) {
    Object.assign(mockSettings, set);
    return;
  }
  await http.put('/mail/settings', set);
}

export async function fetchAppPasswords(): Promise<AppPasswordView[]> {
  if (USE_MOCK) return mockAppPasswords.map(({ secret: _s, ...v }) => v);
  const data = await http.get<AppPasswordView[]>('/mail/app-passwords');
  return data ?? [];
}

export async function createAppPassword(name: string): Promise<AppPasswordPlain> {
  if (USE_MOCK) {
    const plain: AppPasswordPlain = {
      id: `mp-${mockAppPasswords.length + 1}`,
      name,
      created_at: Date.now(),
      secret: Array.from({ length: 24 }, () => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 56)]).join(''),
    };
    mockAppPasswords.push(plain);
    return plain;
  }
  return http.post<AppPasswordPlain>('/mail/app-passwords', { name });
}

export async function revokeAppPassword(id: string): Promise<void> {
  if (USE_MOCK) {
    mockAppPasswords = mockAppPasswords.filter((p) => p.id !== id);
    return;
  }
  await http.delete(`/mail/app-passwords/${id}`);
}

export async function fetchSharedMailboxes(): Promise<SharedMailboxView[]> {
  if (USE_MOCK) return mockShared;
  const data = await http.get<SharedMailboxView[]>('/mail/shared');
  return data ?? [];
}

export async function fetchSharedMessages(
  mailboxId: string,
  folder = 'inbox',
): Promise<MailMessage[]> {
  if (USE_MOCK) return mockSharedMessages(mailboxId);
  const data = await http.get<MailMessage[]>(`/mail/shared/${mailboxId}/messages?folder=${folder}`);
  return data ?? [];
}

export async function sendAsShared(mailboxId: string, req: SendMailReq): Promise<SendMailResp> {
  if (USE_MOCK) return { message_id: `mock-${Date.now()}`, delivered: req.to, undelivered: [] };
  return http.post<SendMailResp>(`/mail/shared/${mailboxId}/messages`, req);
}

// ---------------------------------------------------------------------------
// mock 桩（集中底部；默认死代码，VITE_USE_MOCK=1 才启用）
// ---------------------------------------------------------------------------

const mockFolders = (unread: Record<string, number>) => [
  { name: 'inbox', total_count: 6, unread_count: unread.inbox ?? 0 },
  { name: 'sent', total_count: 4, unread_count: 0 },
  { name: 'drafts', total_count: 1, unread_count: 0 },
  { name: 'trash', total_count: 0, unread_count: 0 },
  { name: 'junk', total_count: 2, unread_count: 0 },
  { name: 'archive', total_count: 0, unread_count: 0 },
];

const mockSummary = (): MailSummary => ({
  address: 'E100001@corp.company.internal',
  status: 1,
  unread: 2,
  quota_used: 128 * 1024 * 1024,
  quota_total: 5 * 1024 * 1024 * 1024,
  folders: mockFolders({ inbox: 2 }),
});

const MOCK_MAILBOX_ID = '101';
const MOCK_FOLDER_ID = '901';

const mockMessage = (
  id: string,
  from: string,
  subject: string,
  snippet: string,
  minsAgo: number,
  flags = 0,
  attach = false,
): MailMessage => ({
  id,
  mailbox_id: MOCK_MAILBOX_ID,
  folder_id: MOCK_FOLDER_ID,
  message_id: `<${id}@bbw.mail>`,
  from_addr: from,
  to_addrs: ['E100001@corp.company.internal'],
  cc_addrs: [],
  subject,
  snippet,
  body: `${snippet}\n\n—— 本邮件为 mock 演示数据。\n\n此致`,
  has_attachment: attach,
  attachments: attach ? [{ file_id: '901', name: '方案.docx', size: 246 * 1024 }] : [],
  flags,
  size: snippet.length + 64,
  received_at: new Date(Date.now() - minsAgo * 60_000).toISOString(),
});

let mockInbox: MailMessage[] = [
  mockMessage('m3', 'zhang@corp.company.internal', '方案定稿，请审阅', '三段结构已按评审意见收敛，附件为终版。', 25, 0, true),
  mockMessage('m2', 'li@corp.company.internal', '采购合同盖章流程', '法务已批，今天下班前走完用印。', 95),
  mockMessage('m1', 'notify@corp.company.internal', '停机维护公告', '本周六 22:00-24:00 数据库例行维护。', 60 * 26, 1),
];
const mockSent: MailMessage[] = [
  mockMessage('s1', 'E100001@corp.company.internal', '回复：方案定稿，请审阅', '收到，两个小建议见批注。', 20, 1),
];

const mockMessages = (folder: string, filter: string): MailMessage[] => {
  const base = folder === 'sent' ? mockSent : folder === 'inbox' ? mockInbox : [];
  return base.filter((m) => {
    if (filter === 'unread') return (m.flags & 1) === 0;
    if (filter === 'starred') return (m.flags & 2) !== 0;
    if (filter === 'attach') return m.has_attachment;
    return true;
  });
};

const mockMessageDetail = (id: string): MailMessage => {
  const all = [...mockInbox, ...mockSent];
  const hit = all.find((m) => m.id === id);
  if (hit) {
    const idx = mockInbox.findIndex((m) => m.id === id);
    if (idx >= 0) mockInbox[idx] = { ...hit, flags: hit.flags | 1 }; // mock 已读
  }
  return hit ?? mockMessage('m0', 'x@corp.company.internal', '(已删除)', '该邮件不存在或已被清理。', 0, 1);
};

const mockSettings: MailSettings = {
  signature: '张三\n研发一部',
  auto_forward: '',
  keep_copy: true,
  remote_images: false,
};

let mockAppPasswords: AppPasswordPlain[] = [
  { id: 'mp-1', name: 'Foxmail', created_at: Date.now() - 86400_000 * 7, secret: 'mock-secret-only-at-creation' },
];

const mockShared: SharedMailboxView[] = [
  { id: '201', address: 'service@corp.company.internal', unread: 1, is_owner: false },
];

const mockSharedMessages = (mailboxId: string): MailMessage[] =>
  mailboxId === '201'
    ? [mockMessage('sm1', 'customer@ext.example', '产品咨询', '请问私有化部署的最低配置？', 40)]
    : [];

/** 存草稿（D16：draft_id>0=更新，返回新 id） */
export async function saveDraft(req: SendMailReq & { draft_id?: string }): Promise<{ id: string }> {
  if (USE_MOCK) {
    await delay(150);
    return { id: `draft-${Date.now()}` };
  }
  return http.post<{ id: string }>('/mail/drafts', req);
}

/** 发送成功后清理草稿（幂等） */
export async function discardDraft(id: string): Promise<void> {
  if (USE_MOCK) return;
  await http.delete(`/mail/drafts/${encodeURIComponent(id)}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
