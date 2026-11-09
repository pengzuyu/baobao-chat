/**
 * MAI-01 邮箱主页（22 §3.5 三栏）：文件夹树（本人+共享邮箱）→ 列表
 * （过滤/翻页）→ 阅读 pane；顶栏搜索（MAI-04 内嵌）+ 写信 + 设置。
 */
import { useMemo, useState } from 'react';
import { Archive, FileText, Inbox, Mail, Pencil, Search, Send, Settings, Star, Trash2, Users } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { StateView } from '../../../shared/ui/StateView';
import { ComposeModal } from '../components/ComposeModal';
import { SettingsDrawer } from '../components/SettingsDrawer';
import {
  useAppPasswords,
  useCreateAppPassword,
  useMailMessage,
  useMailMessages,
  useMailSettings,
  useMailSummary,
  useMailSearch,
  useMarkRead,
  useMoveMessage,
  useRevokeAppPassword,
  useSendAsShared,
  useSendMail,
  useSetStar,
  useSharedMailboxes,
  useSharedMessages,
  useUpdateMailSettings,
} from '../api/hooks';
import type { MailMessage } from '../model/types';

const FOLDER_ICONS: Record<string, React.ReactNode> = {
  inbox: <Inbox size={14} />,
  sent: <Send size={14} />,
  drafts: <FileText size={14} />,
  trash: <Trash2 size={14} />,
  junk: <Archive size={14} />,
  archive: <Archive size={14} />,
};
const FOLDER_LABEL: Record<string, string> = {
  inbox: '收件箱',
  sent: '已发送',
  drafts: '草稿',
  trash: '垃圾',
  junk: '隔离区',
  archive: '归档',
};
const FILTERS: { key: string; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'unread', label: '未读' },
  { key: 'starred', label: '星标' },
  { key: 'attach', label: '附件' },
];

export function MailPage() {
  const [folder, setFolder] = useState('inbox');
  // 草稿续写初值（D16）
  const [draftInit, setDraftInit] = useState<{ id: string; to: string; cc: string; subject: string; body: string } | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<{ addr: string; subject: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searching, setSearching] = useState(false);
  // 共享邮箱视图：null=本人；'shared:<id>' 切共享列表
  const [sharedSel, setSharedSel] = useState<string | null>(null);

  const summary = useMailSummary();
  const shared = useSharedMailboxes();
  const mineQuery = useMailMessages(folder, filter);
  const sharedQuery = useSharedMessages(sharedSel ? sharedSel.slice('shared:'.length) : null);
  const searchQuery = useMailSearch(searchQ);

  const list: MailMessage[] = searching ? searchQuery.data ?? [] : sharedSel ? sharedQuery.data ?? [] : mineQuery.data ?? [];
  const listState = searching
    ? searchQuery.isLoading
      ? 'loading'
      : 'ok'
    : sharedSel
      ? sharedQuery.isLoading
        ? 'loading'
        : 'ok'
      : mineQuery.isLoading
        ? 'loading'
        : 'ok';
  const detail = useMailMessage(selected);
  const markRead = useMarkRead();
  const setStar = useSetStar();
  const move = useMoveMessage();
  const send = useSendMail(() => setComposeOpen(false));
  const sendAs = useSendAsShared(() => setComposeOpen(false));

  const settings = useMailSettings();
  const saveSettings = useUpdateMailSettings();
  const passwords = useAppPasswords();
  const createPwd = useCreateAppPassword();
  const revokePwd = useRevokeAppPassword();

  const folders = summary.data?.folders ?? [];
  const quotaPct = summary.data && summary.data.quota_total > 0
    ? Math.min(100, Math.round((summary.data.quota_used / summary.data.quota_total) * 100))
    : 0;

  const openMessage = (m: MailMessage) => {
    // 草稿箱行点击=续写（D16）：携带原 draft_id 重开写信窗（发送/另存后清理）
    if (folder === 'drafts') {
      setDraftInit({
        id: m.id,
        to: m.to_addrs.join(', '),
        cc: m.cc_addrs.join(', '),
        subject: m.subject,
        body: m.body ?? m.snippet ?? '',
      });
      setComposeOpen(true);
      return;
    }
    setSelected(m.id);
    if ((m.flags & 1) === 0) markRead.mutate(m.id);
  };

  const shownDetail = useMemo<MailMessage | null>(() => {
    if (!selected) return null;
    const cached = list.find((m) => m.id === selected);
    return detail.data ?? cached ?? null;
  }, [selected, detail.data, list]);

  return (
    <div className="mail-page">
      {/* 文件夹树（左栏） */}
      <aside className="mail-tree">
        <div className="mail-tree__head">
          <Mail size={15} />
          <span className="mail-tree__addr">{summary.data?.address ?? '…'}</span>
          <button className="mail-tree__gear" onClick={() => setSettingsOpen(true)} aria-label="邮箱设置">
            <Settings size={15} />
          </button>
        </div>
        <Button variant="primary" className="mail-tree__compose" onClick={() => { setReplyTo(null); setComposeOpen(true); }}>
          <Pencil size={14} /> 写信
        </Button>
        <nav className="mail-tree__folders">
          <div className="mail-tree__group">我的邮箱</div>
          {folders.map((f) => (
            <button
              key={f.name}
              className={`mail-tree__folder${!sharedSel && folder === f.name ? ' is-active' : ''}`}
              onClick={() => { setSharedSel(null); setFolder(f.name); setSelected(null); setSearching(false); }}
            >
              {FOLDER_ICONS[f.name] ?? <Archive size={14} />}
              <span>{FOLDER_LABEL[f.name] ?? f.name}</span>
              {f.unread_count > 0 && <em>{f.unread_count}</em>}
            </button>
          ))}
          {(shared.data ?? []).length > 0 && (
            <>
              <div className="mail-tree__group">
                <Users size={12} /> 部门邮箱（共享）
              </div>
              {(shared.data ?? []).map((b) => (
                <button
                  key={b.id}
                  className={`mail-tree__folder${sharedSel === `shared:${b.id}` ? ' is-active' : ''}`}
                  onClick={() => { setSharedSel(`shared:${b.id}`); setSelected(null); setSearching(false); }}
                  title={b.address}
                >
                  <Inbox size={14} />
                  <span>{b.address.split('@')[0]}</span>
                  {b.unread > 0 && <em>{b.unread}</em>}
                </button>
              ))}
            </>
          )}
        </nav>
        <div className="mail-tree__quota">
          <div className="mail-tree__quota-bar">
            <i style={{ width: `${quotaPct}%` }} />
          </div>
          <span>{quotaPct}% 已用（{summary.data ? (summary.data.quota_used / (1 << 20)).toFixed(0) : '…'} MB / 5 GB）</span>
        </div>
      </aside>

      {/* 列表（中栏） */}
      <section className="mail-list">
        <div className="mail-list__toolbar">
          <div className="mail-list__search">
            <Search size={14} />
            <input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onFocus={() => setSearching(true)}
              placeholder="搜索邮件（主题/发件人/正文）"
            />
            {searching && (
              <button onClick={() => { setSearching(false); setSearchQ(''); }} aria-label="退出搜索">
                ×
              </button>
            )}
          </div>
          {!searching && !sharedSel && (
            <div className="mail-list__filters">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  className={filter === f.key ? 'is-active' : ''}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <StateView state={listState === 'ok' && list.length === 0 ? 'empty' : listState} emptyText={searching ? '无匹配邮件' : '此文件夹为空'}>
          <ul className="mail-list__items">
            {list.map((m) => (
              <li
                key={m.id}
                className={`mail-item${selected === m.id ? ' is-active' : ''}${(m.flags & 1) === 0 ? ' is-unread' : ''}`}
                onClick={() => openMessage(m)}
              >
                <div className="mail-item__main">
                  <span className="mail-item__from">{m.from_addr.split('@')[0]}</span>
                  <span className="mail-item__subject">{m.subject}</span>
                  {m.has_attachment && <small className="mail-item__att">📎</small>}
                </div>
                <div className="mail-item__meta">
                  <time>{new Date(m.received_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
                </div>
                <div className="mail-item__snippet">{m.snippet}</div>
              </li>
            ))}
          </ul>
        </StateView>
      </section>

      {/* 阅读（右栏） */}
      <section className="mail-view">
        {shownDetail ? (
          <article className="mail-view__inner">
            <header className="mail-view__head">
              <h3>{shownDetail.subject}</h3>
              <div className="mail-view__actions">
                <button
                  className={(shownDetail.flags & 2) !== 0 ? 'is-starred' : ''}
                  onClick={() => setStar.mutate({ id: shownDetail.id, on: (shownDetail.flags & 2) === 0 })}
                  aria-label="星标"
                >
                  <Star size={15} />
                </button>
                <button onClick={() => { setReplyTo({ addr: shownDetail.from_addr, subject: shownDetail.subject }); setComposeOpen(true); }} aria-label="回复">
                  回复
                </button>
                <button onClick={() => { move.mutate({ id: shownDetail.id, folder: 'trash' }); setSelected(null); }} aria-label="移入垃圾">
                  <Trash2 size={15} />
                </button>
              </div>
            </header>
            <div className="mail-view__meta">
              <span>发件人：{shownDetail.from_addr}</span>
              <span>收件人：{shownDetail.to_addrs.join('、')}</span>
              <time>{new Date(shownDetail.received_at).toLocaleString('zh-CN')}</time>
            </div>
            {(shownDetail.attachments ?? []).length > 0 && (
              <ul className="mail-view__atts">
                {shownDetail.attachments.map((a) => (
                  <li key={a.file_id}>
                    <FileText size={13} /> {a.name}
                    <small>（{(a.size / 1024).toFixed(0)} KB · 存文件域阶段二）</small>
                  </li>
                ))}
              </ul>
            )}
            <pre className="mail-view__body">{shownDetail.body ?? shownDetail.snippet}</pre>
          </article>
        ) : (
          <div className="mail-view__placeholder">
            <Mail size={40} strokeWidth={1.2} />
            <p>选择一封邮件开始阅读</p>
          </div>
        )}
      </section>

      {composeOpen && (
        <ComposeModal
          onClose={() => {
            setComposeOpen(false);
            setDraftInit(null);
          }}
          onSend={(req) => send.mutateAsync(req)}
          onSendAs={(mailboxId, req) => sendAs.mutateAsync({ mailboxId, req })}
          sharedOwnerBoxes={shared.data ?? []}
          replyTo={replyTo}
          draftInit={draftInit}
          onDraftSaved={() => {
            void mineQuery.refetch();
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDrawer
          onClose={() => setSettingsOpen(false)}
          settings={settings.data ?? { signature: '', auto_forward: '', keep_copy: true, remote_images: false }}
          onSave={(s) => saveSettings.mutate(s)}
          passwords={passwords.data ?? []}
          onCreatePassword={(name) => createPwd.mutateAsync(name)}
          onRevokePassword={(id) => revokePwd.mutate(id)}
        />
      )}
    </div>
  );
}
