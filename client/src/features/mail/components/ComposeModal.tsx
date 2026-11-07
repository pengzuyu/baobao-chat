/**
 * MAI-02 写信窗（22 §3.5）：收件人/抄送/主题/正文/附件（file_id 引用展示）
 * + 发件身份（本人/共享邮箱 owner 代发）。
 */
import { useMemo, useState } from 'react';
import { Paperclip, Send, X } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import type { SendMailResp, SharedMailboxView } from '../model/types';

interface Props {
  onClose: () => void;
  onSend: (req: {
    to: string[];
    cc: string[];
    subject: string;
    body: string;
  }) => Promise<SendMailResp | undefined>;
  sharedOwnerBoxes?: SharedMailboxView[];
  onSendAs?: (mailboxId: string, req: { to: string[]; cc: string[]; subject: string; body: string }) => Promise<SendMailResp | undefined>;
  replyTo?: { addr: string; subject: string } | null;
}

export function ComposeModal({ onClose, onSend, sharedOwnerBoxes = [], onSendAs, replyTo }: Props) {
  const [to, setTo] = useState(replyTo ? replyTo.addr : '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(replyTo ? (replyTo.subject.startsWith('回复：') ? replyTo.subject : `回复：${replyTo.subject}`) : '');
  const [body, setBody] = useState('');
  const [identity, setIdentity] = useState('me'); // me | shared:<id>
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendMailResp | null>(null);

  const ownerBoxes = useMemo(() => sharedOwnerBoxes.filter((b) => b.is_owner), [sharedOwnerBoxes]);

  const splitAddrs = (s: string): string[] =>
    s.split(/[,;，；\s]+/).map((x) => x.trim()).filter(Boolean);

  const send = async () => {
    const req = { to: splitAddrs(to), cc: splitAddrs(cc), subject: subject.trim(), body };
    if (req.to.length === 0 || !req.subject) return;
    setSending(true);
    try {
      const resp =
        identity !== 'me' && onSendAs
          ? await onSendAs(identity.slice('shared:'.length), req)
          : await onSend(req);
      setResult(resp ?? null);
      if (resp) setTimeout(onClose, 900);
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
            <div className="mail-compose__foot">
              <span className="mail-compose__hint">
                <Paperclip size={13} /> 附件经文件域上传后引用（阶段二）
              </span>
              <Button variant="primary" loading={sending} onClick={() => void send()}>
                <Send size={14} /> 发送
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
