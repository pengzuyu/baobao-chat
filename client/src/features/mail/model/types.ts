// 邮件域类型（22 篇 §5/§6.1 REST 契约同构）
export interface MailFolderStat {
  name: string;
  total_count: number;
  unread_count: number;
}

export interface MailSummary {
  address: string;
  status: number;
  unread: number;
  quota_used: number;
  quota_total: number;
  folders: MailFolderStat[];
}

export interface MailAttachment {
  file_id: string;
  name: string;
  size: number;
}

export interface MailMessage {
  id: string;
  mailbox_id: string;
  folder_id: string;
  message_id: string;
  in_reply_to?: string;
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string;
  snippet: string;
  body?: string;
  has_attachment: boolean;
  attachments: MailAttachment[];
  flags: number; // bit0 seen bit1 flagged
  size: number;
  received_at: string; // ISO
}

export interface SendMailReq {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments?: MailAttachment[];
  in_reply_to?: string;
}

export interface MailDelivery {
  address: string;
  ok: boolean;
  reason?: number;
}

export interface SendMailResp {
  message_id: string;
  delivered: string[];
  undelivered: MailDelivery[];
}

export interface MailSettings {
  signature: string;
  auto_forward: string;
  keep_copy: boolean;
  remote_images: boolean;
}

export interface AppPasswordView {
  id: string;
  name: string;
  created_at: number; // ms
}

export interface AppPasswordPlain extends AppPasswordView {
  secret: string;
}

export interface SharedMailboxView {
  id: string;
  address: string;
  unread: number;
  is_owner: boolean;
}
