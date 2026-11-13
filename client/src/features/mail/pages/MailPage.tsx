/**
 * MAI-01 邮箱主页（22 §3.5 三栏）：文件夹树（本人+共享邮箱）→ 列表
 * （过滤/翻页）→ 阅读 pane；顶栏搜索（MAI-04 内嵌）+ 写信 + 设置。
 * D26-O3：mail-* 自研结构退役——左栏 Menu+Progress 配额、过滤 chip→Segmented、
 * 邮件列表→List、阅读 pane Typography 化；布局走内联 flex/grid + theme token。
 */
import { useMemo, useState } from 'react';
import { Badge, Button as AntdButton, Flex, Input, List, Menu, Progress, Segmented, Space, theme, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { Archive, FileText, Inbox, Mail, Pencil, Search, Send, Settings, Star, Trash2, Users, X } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { StateView } from '../../../shared/ui/StateView';
import { SplitHandle, useSplitWidth } from '../../../shared/ui/Splitter';
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
  const { token } = theme.useToken();
  // 左栏拖拽调宽（grid 首列；全站左侧栏统一能力）
  const mailSplit = useSplitWidth('mail-tree', 216, 170, 340);
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

  // 左栏文件夹树（antd Menu group）：我的邮箱 + 部门邮箱（共享）
  const menuItems: MenuProps['items'] = useMemo(
    () => [
      {
        key: 'group-mine',
        type: 'group' as const,
        label: '我的邮箱',
        children: folders.map((f) => ({
          key: f.name,
          icon: FOLDER_ICONS[f.name] ?? <Archive size={14} />,
          label: (
            <Flex align="center" justify="space-between" style={{ minWidth: 0 }}>
              <span>{FOLDER_LABEL[f.name] ?? f.name}</span>
              {f.unread_count > 0 ? <Badge count={f.unread_count} size="small" /> : null}
            </Flex>
          ),
        })),
      },
      ...(shared.data ?? []).length > 0
        ? [
            {
              key: 'group-shared',
              type: 'group' as const,
              label: (
                <Space size={4}>
                  <Users size={12} /> 部门邮箱（共享）
                </Space>
              ),
              children: (shared.data ?? []).map((b) => ({
                key: `shared:${b.id}`,
                icon: <Inbox size={14} />,
                title: b.address,
                label: (
                  <Flex align="center" justify="space-between" style={{ minWidth: 0 }}>
                    <span>{b.address.split('@')[0]}</span>
                    {b.unread > 0 ? <Badge count={b.unread} size="small" /> : null}
                  </Flex>
                ),
              })),
            },
          ]
        : [],
    ],
    [folders, shared.data],
  );

  const onMenuClick: MenuProps['onClick'] = ({ key }) => {
    setSelected(null);
    setSearching(false);
    if (key.startsWith('shared:')) setSharedSel(key);
    else {
      setSharedSel(null);
      setFolder(key);
    }
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `${mailSplit.width}px 5px 340px 1fr`,
        height: '100%',
        flex: 1,
        minHeight: 0,
      }}
    >
      {/* 文件夹树（左栏） */}
      <aside
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '12px 10px',
          minHeight: 0,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Flex align="center" gap={6}>
          <Mail size={15} />
          <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }} title={summary.data?.address}>
            {summary.data?.address ?? '…'}
          </Typography.Text>
          <AntdButton
            type="text"
            size="small"
            icon={<Settings size={15} />}
            onClick={() => setSettingsOpen(true)}
            aria-label="邮箱设置"
          />
        </Flex>
        <Button style={{ width: '100%' }} onClick={() => { setReplyTo(null); setComposeOpen(true); }}>
          <Pencil size={14} /> 写信
        </Button>
        <Menu
          mode="inline"
          items={menuItems}
          selectedKeys={[sharedSel ?? folder]}
          onClick={onMenuClick}
          style={{ flex: 1, overflowY: 'auto', minHeight: 0, borderInlineEnd: 'none', minWidth: 0 }}
        />
        <div style={{ padding: '0 4px' }}>
          <Progress percent={quotaPct} showInfo={false} size="small" style={{ marginBottom: 4 }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {quotaPct}% 已用（{summary.data ? (summary.data.quota_used / (1 << 20)).toFixed(0) : '…'} MB / 5 GB）
          </Typography.Text>
        </div>
      </aside>
      <SplitHandle bind={mailSplit.bind} style={{ marginLeft: 0 }} />

      {/* 列表（中栏） */}
      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Flex align="center" gap={8} style={{ padding: 10, borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
          <Input
            prefix={<Search size={14} />}
            allowClear
            style={{ flex: 1, minWidth: 0 }}
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onFocus={() => setSearching(true)}
            placeholder="搜索邮件（主题/发件人/正文）"
          />
          {searching && (
            <AntdButton
              type="text"
              size="small"
              icon={<X size={14} />}
              onClick={() => { setSearching(false); setSearchQ(''); }}
              aria-label="退出搜索"
            />
          )}
          {!searching && !sharedSel && (
            <Segmented
              value={filter}
              onChange={(v) => setFilter(v as string)}
              options={FILTERS.map((f) => ({ value: f.key, label: f.label }))}
            />
          )}
        </Flex>
        <StateView state={listState === 'ok' && list.length === 0 ? 'empty' : listState} emptyText={searching ? '无匹配邮件' : '此文件夹为空'}>
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            <List
              dataSource={list}
              rowKey="id"
              renderItem={(m) => {
                const unread = (m.flags & 1) === 0;
                return (
                  <List.Item
                    onClick={() => openMessage(m)}
                    style={{
                      padding: '10px 12px',
                      cursor: 'pointer',
                      display: 'block',
                      background: selected === m.id ? token.colorPrimaryBg : undefined,
                    }}
                  >
                    <Flex align="center" gap={8} style={{ minWidth: 0 }}>
                      <Typography.Text strong={unread} ellipsis style={{ flexShrink: 0, maxWidth: 96 }}>
                        {m.from_addr.split('@')[0]}
                      </Typography.Text>
                      <Typography.Text strong={unread} ellipsis style={{ flex: 1, minWidth: 0 }}>
                        {m.subject}
                      </Typography.Text>
                      {m.has_attachment && <span style={{ fontSize: 12 }}>📎</span>}
                      <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
                        {new Date(m.received_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </Typography.Text>
                    </Flex>
                    <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, display: 'block', maxWidth: '100%' }}>
                      {m.snippet}
                    </Typography.Text>
                  </List.Item>
                );
              }}
            />
          </div>
        </StateView>
      </section>

      {/* 阅读（右栏） */}
      <section style={{ minWidth: 0, display: 'flex', minHeight: 0 }}>
        {shownDetail ? (
          <article style={{ flex: 1, padding: '20px 24px', overflowY: 'auto', minWidth: 0 }}>
            <Flex align="flex-start" gap={12}>
              <Typography.Title level={5} style={{ flex: 1, margin: 0, minWidth: 0 }}>
                {shownDetail.subject}
              </Typography.Title>
              <Space size={0}>
                <AntdButton
                  type="text"
                  size="small"
                  icon={<Star size={15} color={(shownDetail.flags & 2) !== 0 ? '#f7ba1e' : undefined} />}
                  onClick={() => setStar.mutate({ id: shownDetail.id, on: (shownDetail.flags & 2) === 0 })}
                  aria-label="星标"
                />
                <Button variant="secondary" size="small" onClick={() => { setReplyTo({ addr: shownDetail.from_addr, subject: shownDetail.subject }); setComposeOpen(true); }}>
                  回复
                </Button>
                <AntdButton
                  type="text"
                  size="small"
                  icon={<Trash2 size={15} />}
                  onClick={() => { move.mutate({ id: shownDetail.id, folder: 'trash' }); setSelected(null); }}
                  aria-label="移入垃圾"
                />
              </Space>
            </Flex>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                margin: '12px 0',
                paddingBottom: 12,
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>发件人：{shownDetail.from_addr}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>收件人：{shownDetail.to_addrs.join('、')}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {new Date(shownDetail.received_at).toLocaleString('zh-CN')}
              </Typography.Text>
            </div>
            {(shownDetail.attachments ?? []).length > 0 && (
              <List
                size="small"
                style={{ marginBottom: 12 }}
                dataSource={shownDetail.attachments}
                rowKey="file_id"
                renderItem={(a) => (
                  <List.Item style={{ padding: '4px 0', fontSize: 12 }}>
                    <Space size={6}>
                      <FileText size={13} /> {a.name}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        （{(a.size / 1024).toFixed(0)} KB · 存文件域阶段二）
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            )}
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontSize: 14, lineHeight: 1.7, fontFamily: 'inherit' }}>
              {shownDetail.body ?? shownDetail.snippet}
            </pre>
          </article>
        ) : (
          <Flex flex={1} vertical align="center" justify="center" gap={10}>
            <Mail size={40} strokeWidth={1.2} />
            <Typography.Text type="secondary">选择一封邮件开始阅读</Typography.Text>
          </Flex>
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
