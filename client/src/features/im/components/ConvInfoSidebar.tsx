/**
 * 详情侧栏（D03 §3.5 PIM-05 + §3.6 群文件页签）：
 * - 单聊：对方名片（元信息只读）
 * - 群聊/广播群：五 tab（信息/成员/群文件/设置/公告）——设置 tab 仅 owner/admin 可见
 * - 操作全接真实 API：退群/转让/解散（危险确认）、添加成员（选人器）、
 *   设/取消管理员、单人禁言（预设时长）、移出、群名/策略/全员禁言、公告编辑、
 *   群文件列表+票据下载（GET /files/convs/{id}，D06 阶段二）
 * - conv.updated 推送经 conv 摘要变化触发详情重拉（memberCount/groupSetting 依赖）
 * D26-O5：表单件与确认已 antd 化（Input/Select/TextArea/Modal.confirm）。
 * D26-O6（本批）：布局层退役 detail-panel/gm-* 类——骨架内联 token、四 tab→antd Tabs、
 * 成员/文件行内联、操作钮→shared Button、徽标→Tag、错误条→Alert。
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Input, Modal, Select, Tabs, Tag, Typography, theme } from 'antd';
import { FileText, Hash, Megaphone, ScrollText, Settings2, Shield, Tag as TagIcon, Users, VolumeX, X } from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { Button } from '../../../shared/ui/Button';
import { getErrorText } from '../../../shared/api/http';
import { formatBytes } from '../../../shared/utils/format';
import {
  convDissolve,
  convQuit,
  convSetting,
  fetchConvDetail,
  fetchConvMembers,
  memberAdd,
  memberRemove,
  memberRole,
} from '../api/im';
import { downloadUrl, fetchConvFiles, getDownloadTicket, type MyFileItem } from '../api/files';
import { PersonPickerModal } from './PersonPicker';
import { useImStore } from '../store/im';
import { formatMuteUntil } from '../pages/systemMessageRegistry';
import type { Conversation, ConversationMember, MemberRole } from '../model/types';

interface ConvInfoSidebarProps {
  conv: Conversation;
  myUid: string;
  /** 初始 tab（公告横幅入口直达公告，其余默认信息） */
  initialTab?: TabKey;
  onClose?: () => void;
  /** 退群/解散成功（端内退出会话视图） */
  onLeft?: (convId: string) => void;
}

type TabKey = 'info' | 'members' | 'files' | 'setting' | 'announcement';

const ROLE_LABEL: Record<number, string> = { 1: '群主', 2: '管理员', 3: '成员', 4: '发布者' };

/** 成员角色徽标色（原 gm-member__role--1/--2：群主主色/管理员橙） */
function roleTagColor(role: number): string | undefined {
  if (role === 1) return 'geekblue';
  if (role === 2) return 'orange';
  return undefined;
}

/** 单人禁言预设（≤30 天/次，04 篇 §4.5.3） */
const MUTE_PRESETS = [
  { label: '10 分钟', ms: 10 * 60_000 },
  { label: '1 小时', ms: 60 * 60_000 },
  { label: '1 天', ms: 24 * 60 * 60_000 },
];

export function ConvInfoSidebar({ conv, myUid, initialTab = 'info', onClose, onLeft }: ConvInfoSidebarProps) {
  const { token } = theme.useToken();
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [detail, setDetail] = useState<ConversationMember[]>([]);
  const [myRole, setMyRole] = useState<MemberRole | undefined>(conv.myRole);
  const [groupAnnouncement, setGroupAnnouncement] = useState<string | undefined>(conv.groupSetting?.announcement);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 邀请成员选人器（M3：替代手输 uid——通讯录多选，排除已有成员） */
  const [inviteOpen, setInviteOpen] = useState(false);

  const isGroup = conv.type !== 1;
  const isMgr = myRole === 1 || myRole === 2;
  const typeLabel = conv.type === 1 ? '单聊' : conv.type === 2 ? '群聊' : '广播群';

  // 详情/成员拉取：conv 摘要变化（conv.updated 推送合并）即重拉
  const reload = useCallback(async () => {
    if (!isGroup) return;
    setError(null);
    try {
      const [d, members] = await Promise.all([fetchConvDetail(conv.id), fetchConvMembers(conv.id)]);
      setDetail(members);
      setMyRole(d.myRole || conv.myRole);
      setGroupAnnouncement(d.groupSetting?.announcement);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }, [conv.id, conv.myRole, isGroup]);

  useEffect(() => {
    void reload();
  }, [reload, conv.memberCount, conv.groupSetting?.announcementTs]);

  /** 统一操作执行器：busy + 错误 toast 文案 */
  const run = useCallback(async (fn: () => Promise<void>, done?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      done?.();
      await reload();
    } catch (e) {
      setError(e && typeof e === 'object' && 'code' in e ? getErrorText((e as { code: number }).code) : '操作失败');
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const leave = () =>
    void run(
      () => convQuit(conv.id),
      () => onLeft?.(conv.id),
    );

  const dissolve = () =>
    void run(
      () => convDissolve(conv.id),
      () => onLeft?.(conv.id),
    );

  /** 元信息行（原 detail-panel__kv，内联；last=去底边线） */
  const kv = (key: ReactNode, value: ReactNode, last = false): ReactNode => (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
        padding: '8px 0',
        borderBottom: last ? 'none' : `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Typography.Text type="secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {key}
      </Typography.Text>
      {value}
    </div>
  );

  const statusTag = (
    <Tag color={conv.status === 1 ? 'success' : 'default'}>{conv.status === 1 ? '活跃' : '已解散（只读）'}</Tag>
  );

  const tabPanes: Record<TabKey, ReactNode> = {
    info: (
      <InfoTab
        conv={conv}
        members={detail}
        myUid={myUid}
        myRole={myRole}
        busy={busy}
        onQuit={leave}
        onDissolve={dissolve}
        onTransfer={(uid) =>
          void run(() => memberRole(conv.id, uid, 1))
        }
        kv={kv}
        statusTag={statusTag}
      />
    ),
    members: (
      <MembersTab
        conv={conv}
        members={detail}
        myUid={myUid}
        myRole={myRole}
        busy={busy}
        onInvite={() => setInviteOpen(true)}
        onRemove={(uid) => void run(() => memberRemove(conv.id, uid))}
        onRole={(uid, role) => void run(() => memberRole(conv.id, uid, role))}
        onTransferMember={(uid) => void run(() => memberRole(conv.id, uid, 1))}
        onMute={(uid, until) =>
          void run(() => convSetting(conv.id, { mute_member: { uid, until } }))
        }
      />
    ),
    files: <ConvFilesTab convId={conv.id} />,
    setting: <SettingTab conv={conv} busy={busy} onPatch={(patch) => void run(() => convSetting(conv.id, patch))} />,
    announcement: (
      <AnnouncementTab
        conv={conv}
        announcement={groupAnnouncement}
        busy={busy}
        canEdit={isMgr || myRole === 4}
        onSubmit={(text) => void run(() => convSetting(conv.id, { announcement: text }))}
      />
    ),
  };

  const tabs = useMemo(() => {
    const base: Array<{ key: TabKey; label: string; icon: typeof TagIcon }> = [
      { key: 'info', label: '信息', icon: TagIcon },
      { key: 'members', label: '成员', icon: Users },
      { key: 'files', label: '群文件', icon: FileText }, // D03 §3.6（成员可见，服务端成员判定）
    ];
    if (isMgr) base.push({ key: 'setting', label: '设置', icon: Settings2 }); // 仅 owner/admin（D03 §3.5）
    base.push({ key: 'announcement', label: '公告', icon: Megaphone });
    return base;
  }, [isMgr]);

  return (
    <aside style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography.Text strong style={{ fontSize: 16 }}>
          {conv.name}
        </Typography.Text>
        {onClose ? (
          <Button variant="text" size="small" icon={<X size={16} />} onClick={onClose} title="收起" />
        ) : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '8px 0' }}>
        <Avatar name={conv.name} size={64} group={conv.type === 3 ? 'broadcast' : conv.type === 2 ? 'group' : null} />
        <Tag>{typeLabel}</Tag>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      {!isGroup ? (
        /* 单聊=名片（PIM-05：非群聊仅元信息） */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadiusLG, padding: '4px 12px' }}>
            {kv(
              <>
                <TagIcon size={14} /> 类型
              </>,
              <span>{typeLabel}</span>,
            )}
            {kv(
              <>
                <Users size={14} /> 成员数
              </>,
              <span>{conv.memberCount}</span>,
            )}
            {kv(
              <>
                <ScrollText size={14} /> 状态
              </>,
              statusTag,
              true,
            )}
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadiusLG, padding: '4px 12px' }}>
              {kv(
                <>
                  <Users size={14} /> 成员
                </>,
                <span>
                  {conv.memberCount}
                  {conv.type === 2 ? ' / 500' : ' / 5000'}
                </span>,
              )}
              {kv(
                <>
                  <Shield size={14} /> 我的角色
                </>,
                <span>{ROLE_LABEL[myRole ?? 3]}</span>,
                true,
              )}
            </div>
          </div>

          {/* 四 tab（PIM-05；原 gm-tabs → antd Tabs） */}
          <Tabs
            size="small"
            activeKey={tab}
            onChange={(k) => setTab(k as TabKey)}
            items={tabs.map((t) => ({
              key: t.key,
              label: (
                <span style={{ fontSize: 12 }}>
                  <t.icon size={13} style={{ verticalAlign: '-2px' }} /> {t.label}
                </span>
              ),
              children: <div style={{ padding: '12px 0' }}>{tabPanes[t.key]}</div>,
            }))}
          />
        </>
      )}
      {/* 邀请成员选人器（M3）：通讯录多选，排除已有成员；确认即 memberAdd */}
      <PersonPickerModal
        open={inviteOpen}
        title={`邀请成员加入「${conv.name}」`}
        multiple
        excludeUids={detail.map((m) => m.uid)}
        onClose={() => setInviteOpen(false)}
        onConfirm={(picked) => {
          if (picked.length === 0) return;
          void run(async () => {
            await memberAdd(conv.id, picked.map((p) => p.uid));
          });
        }}
      />
    </aside>
  );
}

/* ── 信息 tab ── */

function InfoTab({
  conv,
  members,
  myUid,
  myRole,
  busy,
  onQuit,
  onDissolve,
  onTransfer,
  kv,
  statusTag,
}: {
  conv: Conversation;
  members: ConversationMember[];
  myUid: string;
  myRole?: MemberRole;
  busy: boolean;
  onQuit: () => void;
  onDissolve: () => void;
  onTransfer: (uid: string) => void;
  /** 元信息行渲染器（壳层注入，统一内联口径） */
  kv: (key: ReactNode, value: ReactNode, last?: boolean) => ReactNode;
  statusTag: ReactNode;
}) {
  const { token } = theme.useToken();
  const [confirm, setConfirm] = useState<'quit' | 'dissolve' | null>(null);
  const [transferUid, setTransferUid] = useState('');
  const owner = members.find((m) => m.role === 1);
  const iAmOwner = myRole === 1;
  const muteAll = conv.groupSetting?.muteAllUntil ?? 0;

  /** 操作块（原 gm-op：边框浅底容器） */
  const opBlock = (label: string | null, children: ReactNode): ReactNode => (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 10,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadius,
        background: token.colorFillQuaternary,
      }}
    >
      {label ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {label}
        </Typography.Text>
      ) : null}
      {children}
    </div>
  );

  /** 危险二次确认行（原 gm-confirm） */
  const confirmRow = (text: string, okText: string, onConfirmClick: () => void, busyFlag: boolean): ReactNode => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: token.colorError }}>
      <span>{text}</span>
      <Button variant="danger" size="small" disabled={busyFlag} onClick={onConfirmClick}>
        {okText}
      </Button>
      <Button variant="text" size="small" onClick={() => setConfirm(null)}>
        取消
      </Button>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {kv(
        <>
          <TagIcon size={14} /> 群名
        </>,
        <span>{conv.name}</span>,
      )}
      {kv(
        <>
          <Hash size={14} /> 群主
        </>,
        <span>{owner ? `${owner.displayName}（${owner.uid === myUid ? '我' : owner.uid}）` : '—'}</span>,
      )}
      {kv(
        <>
          <ScrollText size={14} /> 状态
        </>,
        statusTag,
      )}
      {muteAll > Date.now()
        ? kv(
            <>
              <VolumeX size={14} /> 全员禁言
            </>,
            <span>至 {formatMuteUntil(muteAll)}</span>,
            true,
          )
        : null}

      {/* 转让（owner，危险确认，D01 §8） */}
      {iAmOwner && conv.status === 1 ? (
        opBlock(
          '转让群主',
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input
              placeholder="目标成员 uid"
              value={transferUid}
              onChange={(e) => setTransferUid(e.target.value)}
              data-testid="transfer-uid"
            />
            <Button
              variant="secondary"
              disabled={busy || !transferUid.trim()}
              onClick={() => {
                const uid = transferUid.trim();
                Modal.confirm({
                  title: `确认将群主转让给 ${uid}？`,
                  content: '转让后你变为普通成员',
                  okText: '转让',
                  okButtonProps: { danger: true },
                  cancelText: '取消',
                  onOk: () => {
                    onTransfer(uid);
                    setTransferUid('');
                  },
                });
              }}
            >
              转让
            </Button>
          </div>,
        )
      ) : null}

      {conv.status === 1 && !iAmOwner ? (
        opBlock(
          null,
          confirm === 'quit' ? (
            confirmRow('确认退出该群？', '确认退群', onQuit, busy)
          ) : (
            <Button variant="secondary" onClick={() => setConfirm('quit')}>
              退出群聊
            </Button>
          ),
        )
      ) : null}

      {iAmOwner && conv.status === 1 ? (
        opBlock(
          null,
          confirm === 'dissolve' ? (
            confirmRow('解散后不可恢复，确认解散？', '确认解散', onDissolve, busy)
          ) : (
            <Button variant="danger" onClick={() => setConfirm('dissolve')}>
              解散群聊
            </Button>
          ),
        )
      ) : null}
    </div>
  );
}

/* ── 成员 tab ── */

function MembersTab({
  conv,
  members,
  myUid,
  myRole,
  busy,
  onInvite,
  onRemove,
  onRole,
  onTransferMember,
  onMute,
}: {
  conv: Conversation;
  members: ConversationMember[];
  myUid: string;
  myRole?: MemberRole;
  busy: boolean;
  /** 邀请成员（M3：通讯录选人器，排除已有成员） */
  onInvite: () => void;
  onRemove: (uid: string) => void;
  onRole: (uid: string, role: 2 | 3) => void;
  /** 转让群主（role=1，危险确认后调用） */
  onTransferMember: (uid: string) => void;
  onMute: (uid: string, until: number) => void;
}) {
  const { token } = theme.useToken();
  const iAmOwner = myRole === 1;
  const iAmMgr = myRole === 1 || myRole === 2;
  const muted = (m: ConversationMember) => (m.muteUntil ?? 0) > Date.now();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* 邀请成员（M3）：通讯录多选弹窗（PersonPickerModal，群内已有成员自动排除） */}
      {iAmMgr && conv.status === 1 ? (
        <div data-testid="add-member">
          <Button disabled={busy} onClick={onInvite}>
            邀请成员
          </Button>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {members.map((m, idx) => (
          <div
            key={m.uid}
            data-uid={m.uid}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 4px',
              borderBottom: idx === members.length - 1 ? 'none' : `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <Avatar name={m.displayName} size={32} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                {m.uid === myUid ? `${m.displayName}（我）` : m.displayName}
                {m.role !== 3 ? (
                  <Tag color={roleTagColor(m.role)} style={{ fontSize: 10, lineHeight: '16px', paddingInline: 5, marginInlineEnd: 0 }}>
                    {ROLE_LABEL[m.role]}
                  </Tag>
                ) : null}
                {muted(m) ? (
                  <Tag color="error" style={{ fontSize: 10, lineHeight: '16px', paddingInline: 5, marginInlineEnd: 0 }}>
                    禁言中
                  </Tag>
                ) : null}
              </span>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {m.uid}
              </Typography.Text>
            </div>
            {iAmMgr && m.uid !== myUid && conv.status === 1 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}>
                {/* admin 不能动 owner/admin（服务端矩阵兜底 3015） */}
                {iAmOwner ? (
                  <>
                    <Button variant="secondary" size="small" disabled={busy} onClick={() => onRole(m.uid, m.role === 2 ? 3 : 2)}>
                      {m.role === 2 ? '取消管理员' : '设为管理员'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      danger
                      disabled={busy}
                      onClick={() =>
                        Modal.confirm({
                          title: `确认将群主转让给 ${m.displayName}？`,
                          okText: '转让',
                          okButtonProps: { danger: true },
                          cancelText: '取消',
                          onOk: () => onTransferMember(m.uid),
                        })
                      }
                    >
                      转让
                    </Button>
                  </>
                ) : null}
                {/* 禁言矩阵（04 篇 §4.5.1）：admin 仅 member 级；owner 可 member/admin（服务端兜底 3015） */}
                {m.role === 3 || (iAmOwner && m.role === 2) ? (
                  muted(m) ? (
                    <Button variant="secondary" size="small" disabled={busy} onClick={() => onMute(m.uid, 0)}>
                      解除禁言
                    </Button>
                  ) : (
                    MUTE_PRESETS.map((p) => (
                      <Button
                        key={p.label}
                        variant="secondary"
                        size="small"
                        disabled={busy}
                        onClick={() => onMute(m.uid, Date.now() + p.ms)}
                        title={`禁言 ${p.label}`}
                      >
                        禁言{p.label}
                      </Button>
                    ))
                  )
                ) : null}
                <Button
                  variant="secondary"
                  size="small"
                  danger
                  disabled={busy}
                  onClick={() =>
                    Modal.confirm({
                      title: `确认将 ${m.displayName} 移出群聊？`,
                      okText: '移出',
                      okButtonProps: { danger: true },
                      cancelText: '取消',
                      onOk: () => onRemove(m.uid),
                    })
                  }
                >
                  移出
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 群文件 tab（D03 §3.6；GET /files/convs/{id} 成员可见 + 票据下载） ── */

function ConvFilesTab({ convId }: { convId: string }) {
  const { token } = theme.useToken();
  const [items, setItems] = useState<MyFileItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const navigate = useNavigate();
  const setPendingLocate = useImStore((s) => s.setPendingLocate);

  /** 定位到原消息（OQ-B24：已撤回锚点置灰不可跳转；与收藏/搜索跳转共用 pendingLocate） */
  const locate = (f: MyFileItem) => {
    if (!f.msgSeq || f.recalled) return;
    setPendingLocate({ convId, seq: f.msgSeq });
    navigate(`/im/c/${convId}`);
  };

  const reload = useCallback(async () => {
    setError(null);
    try {
      setItems(await fetchConvFiles(convId));
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
      setItems([]);
    }
  }, [convId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 下载 = 取一次性票据（120s）→ 打开绝对地址（服务端流式回放） */
  const download = async (f: MyFileItem) => {
    setDownloading(f.id);
    setError(null);
    try {
      const ticket = await getDownloadTicket(f.id);
      window.open(downloadUrl(ticket.url), '_blank');
    } catch (e) {
      setError(e && typeof e === 'object' && 'code' in e ? getErrorText((e as { code: number }).code) : '下载失败');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {items === null ? (
        <Typography.Text type="secondary" style={{ padding: '16px 0', textAlign: 'center', fontSize: 12 }}>
          加载中…
        </Typography.Text>
      ) : items.length === 0 ? (
        <Typography.Text type="secondary" style={{ padding: '16px 0', textAlign: 'center', fontSize: 12 }}>
          暂无群文件
        </Typography.Text>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }} data-testid="conv-files-list">
          {items.map((f, idx) => (
            <div
              key={f.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 4px',
                borderBottom: idx === items.length - 1 ? 'none' : `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <FileText size={13} /> {f.name}
                </span>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {formatBytes(f.size)} · {formatMuteUntil(f.createdAt)}
                </Typography.Text>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={!f.msgSeq || f.recalled}
                  title={f.recalled ? '消息已撤回，无法定位' : f.msgSeq ? '定位到消息' : '未关联消息'}
                  onClick={() => locate(f)}
                >
                  定位
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={downloading === f.id}
                  onClick={() => void download(f)}
                >
                  {downloading === f.id ? '取票据…' : '下载'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── 设置 tab（仅 owner/admin 可见） ── */

function SettingTab({
  conv,
  busy,
  onPatch,
}: {
  conv: Conversation;
  busy: boolean;
  onPatch: (patch: {
    name?: string;
    join_mode?: 1 | 2 | 3;
    invite_policy?: 1 | 2;
    mention_all_policy?: 1 | 2 | 3;
    history_visible?: boolean;
    mute_all_until?: number;
  }) => void;
}) {
  const gs = conv.groupSetting;
  const [name, setName] = useState(conv.name);
  /** 全员禁言时长预设（受控；开启时取此值——替代旧 DOM 取 select.value 路径） */
  const [muteAllPreset, setMuteAllPreset] = useState(3600_000);
  const muteAllOn = (gs?.muteAllUntil ?? 0) > Date.now();

  /** 表单字段块（原 gm-field） */
  const field = (label: string, children: ReactNode): ReactNode => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
      {children}
    </div>
  );
  const row = (children: ReactNode): ReactNode => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {children}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {field(
        '群名（≤50 字）',
        row(
          <>
            <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="group-name-input" />
            <Button variant="secondary" disabled={busy || !name.trim() || name === conv.name} onClick={() => onPatch({ name: name.trim() })}>
              改名
            </Button>
          </>,
        ),
      )}

      {field(
        '入群方式',
        <Select
          style={{ width: '100%' }}
          value={gs?.joinMode ?? 1}
          disabled={busy}
          onChange={(v) => onPatch({ join_mode: v as 1 | 2 | 3 })}
          options={[
            { value: 1, label: '直接加入' },
            { value: 2, label: '需要审批' },
            { value: 3, label: '仅邀请' },
          ]}
        />,
      )}

      {field(
        '邀请权限',
        <Select
          style={{ width: '100%' }}
          value={gs?.invitePolicy ?? 1}
          disabled={busy}
          onChange={(v) => onPatch({ invite_policy: v as 1 | 2 })}
          options={[
            { value: 1, label: '全员可邀' },
            { value: 2, label: '仅管理员' },
          ]}
        />,
      )}

      {field(
        '@全体权限（3014）',
        <Select
          style={{ width: '100%' }}
          value={gs?.mentionAllPolicy ?? 2}
          disabled={busy}
          onChange={(v) => onPatch({ mention_all_policy: v as 1 | 2 | 3 })}
          options={[
            { value: 1, label: '全员可用' },
            { value: 2, label: '仅管理员' },
            { value: 3, label: '禁用' },
          ]}
        />,
      )}

      {field(
        '全员禁言（owner/admin 豁免）',
        row(
          <>
            <Select
              style={{ width: 140 }}
              disabled={busy || muteAllOn}
              value={muteAllPreset}
              onChange={setMuteAllPreset}
              data-testid="mute-all-select"
              options={[
                { value: 600_000, label: '10 分钟' },
                { value: 3600_000, label: '1 小时' },
                { value: 24 * 3600_000, label: '1 天' },
              ]}
            />
            {muteAllOn ? (
              <Button variant="secondary" disabled={busy} onClick={() => onPatch({ mute_all_until: 0 })}>
                解除全员禁言
              </Button>
            ) : (
              <Button
                disabled={busy}
                onClick={() => onPatch({ mute_all_until: Date.now() + muteAllPreset })}
              >
                开启
              </Button>
            )}
          </>,
        ),
      )}

      {field(
        '新成员可见历史消息',
        <Button variant="secondary" disabled={busy} onClick={() => onPatch({ history_visible: !(gs?.historyVisible ?? true) })}>
          {gs?.historyVisible ?? true ? '当前：可见（点击关闭）' : '当前：不可见（点击开启）'}
        </Button>,
      )}
    </div>
  );
}

/* ── 公告 tab ── */

function AnnouncementTab({
  conv,
  announcement,
  busy,
  canEdit,
  onSubmit,
}: {
  conv: Conversation;
  announcement?: string;
  busy: boolean;
  canEdit: boolean;
  onSubmit: (text: string) => void;
}) {
  const { token } = theme.useToken();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(announcement ?? '');

  useEffect(() => {
    setDraft(announcement ?? '');
  }, [announcement]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {announcement ? (
        <div style={{ padding: 10, borderRadius: token.borderRadius, background: token.colorFillQuaternary }} data-testid="announcement-text">
          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{announcement}</div>
          {conv.groupSetting?.announcementTs ? (
            <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
              发布于 {formatMuteUntil(conv.groupSetting.announcementTs)}
            </Typography.Text>
          ) : null}
        </div>
      ) : (
        <Typography.Text type="secondary" style={{ padding: '16px 0', textAlign: 'center', fontSize: 12 }}>
          暂无公告{canEdit ? '，点击下方发布' : ''}
        </Typography.Text>
      )}

      {canEdit && conv.status === 1 ? (
        editing ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              padding: 10,
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadius,
              background: token.colorFillQuaternary,
            }}
          >
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              编辑公告（≤2000 字）
            </Typography.Text>
            <Input.TextArea
              rows={5}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              data-testid="announcement-input"
              placeholder="发布群公告…"
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button
                disabled={busy || !draft.trim()}
                onClick={() => {
                  onSubmit(draft.trim());
                  setEditing(false);
                }}
              >
                发布
              </Button>
              <Button variant="text" onClick={() => setEditing(false)}>
                取消
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setEditing(true)} data-testid="announcement-edit-btn">
            {announcement ? '修改公告' : '发布公告'}
          </Button>
        )
      ) : null}
    </div>
  );
}
