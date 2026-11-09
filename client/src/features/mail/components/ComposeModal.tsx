/**
 * MAI-02 写信窗（22 §3.5）：收件人/抄送/主题/正文/附件 + 发件身份
 * （本人/共享邮箱 owner 代发）。D15：附件经文件域 uploadFileSmart 上传
 * （file_id 引用复用 D06），列表可移除，send 携带 attachments。
 */
import { useMemo, useRef, useState } from 'react';
import { FileText, Paperclip, Send, X } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import type { MailAttachment, SendMailResp, SharedMailboxView } from '../model/types';
import { uploadFileSmart } from '../../im/api/files';
import { discardDraft, saveDraft } from '../api/mail';

interface Props {
  onClose: () => void;
  onSend: (req: {
    to: string[];
    cc: string[];
    subject: string;
    body: string;
    attachments?: MailAttachment[];
  }) => Promise<SendMailResp | undefined>;
  sharedOwnerBoxes?: SharedMailboxView[];
  /** 草稿续写初值（D16：草稿箱行点击进入；携带原 draft_id，发送/另存后清理） */
  draftInit?: { id: string; to: string; cc: string; subject: string; body: string } | null;
  onDraftSaved?: () => void;
  onSendAs?: (mailboxId: string, req: { to: string[]; cc: string[]; subject: string; body: string; attachments?: MailAttachment[] }) => Promise<SendMailResp | undefined>;
  replyTo?: { addr: string; subject: string } | null;
}

export function ComposeModal({ onClose, onSend, sharedOwnerBoxes = [], onSendAs, replyTo, draftInit, onDraftSaved }: Props) {
  const [draftId, setDraftId] = useState(draftInit?.id ?? '');
  const [to, setTo] = useState(draftInit?.to ?? (replyTo ? replyTo.addr : ''));
  const [cc, setCc] = useState(draftInit?.cc ?? '');
  const [subject, setSubject] = useState(draftInit?.subject ?? (replyTo ? (replyTo.subject.startsWith('回复：') ? replyTo.subject : `回复：${replyTo.subject}`) : ''));
  const [body, setBody] = useState(draftInit?.body ?? '');
  const [identity, setIdentity] = useState('me'); // me | shared:<id>
  const [sending, setSending] = useState(false);
  // 附件（D15：上传→file_id 引用→发送携带）
  const [attachments, setAttachments] = useState<MailAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        // 文件域上传（不挂会话；mail 附件语义）；失败跳过该个（不打断多选）
        const res = await uploadFileSmart(f).catch(() => null);
        if (res?.id) {
          setAttachments((prev) => [...prev, { file_id: res.id, name: res.name || f.name, size: res.size || f.size }]);
        }
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const [result, setResult] = useState<SendMailResp | null>(null);

  const ownerBoxes = useMemo(() => sharedOwnerBoxes.filter((b) => b.is_owner), [sharedOwnerBoxes]);

  const splitAddrs = (s: string): string[] =>
    s.split(/[,;，；\s]+/).map((x) => x.trim()).filter(Boolean);

  const saveAsDraft = async () => {
    try {
      const res = await saveDraft({
        to: splitAddrs(to), cc: splitAddrs(cc), subject: subject.trim(), body,
        attachments: attachments.length ? attachments : undefined,
        draft_id: draftId || undefined,
      });
      setDraftId(res.id);
      onDraftSaved?.();
    } catch {
      // 草稿失败不打断（增益）
    }
  };

  const send = async () => {
    const req = { to: splitAddrs(to), cc: splitAddrs(cc), subject: subject.trim(), body, attachments };
    if (req.to.length === 0 || !req.subject) return;
    setSending(true);
    try {
      const resp =
        identity !== 'me' && onSendAs
          ? await onSendAs(identity.slice('shared:'.length), req)
          : await onSend(req);
      setResult(resp ?? null);
      if (resp) {
        if (draftId) void discardDraft(draftId).catch(() => undefined);
        setTimeout(onClose, 900);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mail-compose__mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mail-compose">
        <div className="mail-compose__head">
          <span>写信</span>
          <button className="mail-compose__close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        {result ? (
          <div className="mail-compose__result">
            {result.undelivered.length === 0
              ? `已发送（${result.delivered.length} 位收件人）`
              : `部分送达：${result.delivered.length} 成功 / ${result.undelivered.length} 未送达`}
          </div>
        ) : (
          <div className="mail-compose__body">
            <label className="mail-compose__row">
              <span>发件身份</span>
              <select value={identity} onChange={(e) => setIdentity(e.target.value)}>
                <option value="me">我的邮箱</option>
                {ownerBoxes.map((b) => (
                  <option key={b.id} value={`shared:${b.id}`}>
                    {b.address}（代发）
                  </option>
                ))}
              </select>
            </label>
            <label className="mail-compose__row">
              <span>收件人</span>
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="多人以逗号分隔（本域地址）" autoFocus />
            </label>
            <label className="mail-compose__row">
              <span>抄送</span>
              <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="可选" />
            </label>
            <label className="mail-compose__row">
              <span>主题</span>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="必填" />
            </label>
            <textarea
              className="mail-compose__text"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="正文…"
              rows={10}
            />
            {attachments.length > 0 ? (
              <div className="mail-compose__atts" data-testid="mail-atts">
                {attachments.map((a) => (
                  <span key={a.file_id} className="mail-compose__att" data-testid="mail-att">
                    <FileText size={12} /> {a.name}（{a.size > 1048576 ? `${(a.size / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(a.size / 1024))}KB`}）
                    <button
                      type="button"
                      className="mail-compose__att-x"
                      aria-label={`移除附件 ${a.name}`}
                      onClick={() => setAttachments((prev) => prev.filter((x) => x.file_id !== a.file_id))}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="mail-compose__foot">
              <input
                ref={fileRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => void pickFiles(e.target.files)}
                data-testid="mail-att-input"
              />
              <button type="button" className="mail-compose__att-btn" onClick={() => fileRef.current?.click()} disabled={uploading} data-testid="mail-att-btn">
                <Paperclip size={13} /> {uploading ? '上传中…' : `附件${attachments.length ? `（${attachments.length}）` : ''}`}
              </button>
              <Button variant="secondary" loading={uploading} onClick={() => void saveAsDraft()}>
                存草稿
              </Button>
              <Button variant="primary" loading={sending} onClick={() => void send()} disabled={uploading}>
                <Send size={14} /> 发送
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
