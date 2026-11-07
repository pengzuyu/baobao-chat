/**
 * 详情侧栏（D03 §3.5 PIM-05）：
 * - 单聊：对方名片（元信息只读）
 * - 群聊/广播群：四 tab（信息/成员/设置/公告）——设置 tab 仅 owner/admin 可见
 * - 操作全接真实 API：退群/转让/解散（危险确认）、添加成员（手输 uid）、
 *   设/取消管理员、单人禁言（预设时长）、移出、群名/策略/全员禁言、公告编辑
 * - conv.updated 推送经 conv 摘要变化触发详情重拉（memberCount/groupSetting 依赖）
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Hash, Megaphone, ScrollText, Settings2, Shield, Tag, Users, VolumeX, X } from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { Button } from '../../../shared/ui/Button';
import { getErrorText } from '../../../shared/api/http';
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

type TabKey = 'info' | 'members' | 'setting' | 'announcement';

const ROLE_LABEL: Record<number, string> = { 1: '群主', 2: '管理员', 3: '成员', 4: '发布者' };

/** 单人禁言预设（≤30 天/次，04 篇 §4.5.3） */
const MUTE_PRESETS = [
  { label: '10 分钟', ms: 10 * 60_000 },
  { label: '1 小时', ms: 60 * 60_000 },
  { label: '1 天', ms: 24 * 60 * 60_000 },
];

export function ConvInfoSidebar({ conv, myUid, initialTab = 'info', onClose, onLeft }: ConvInfoSidebarProps) {
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [detail, setDetail] = useState<ConversationMember[]>([]);
  const [myRole, setMyRole] = useState<MemberRole | undefined>(conv.myRole);
  const [groupAnnouncement, setGroupAnnouncement] = useState<string | undefined>(conv.groupSetting?.announcement);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 添加成员（手输 uid，逗号/空白分隔）——正式版接通讯录选人（登记） */
  const [addUids, setAddUids] = useState('');

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

  const tabs = useMemo(() => {
    const base: Array<{ key: TabKey; label: string; icon: typeof Tag }> = [
      { key: 'info', label: '信息', icon: Tag },
      { key: 'members', label: '成员', icon: Users },
    ];
    if (isMgr) base.push({ key: 'setting', label: '设置', icon: Settings2 }); // 仅 owner/admin（D03 §3.5）
    base.push({ key: 'announcement', label: '公告', icon: Megaphone });
    return base;
  }, [isMgr]);

  return (
    <aside className="detail-panel">
      <div className="detail-panel__head">
        <strong className="detail-panel__title">{conv.name}</strong>
        {onClose ? (
          <button className="icon-btn" onClick={onClose} title="收起">
            <X size={16} />
          </button>
        ) : null}
      </div>

      <div className="detail-panel__profile">
        <Avatar name={conv.name} size={64} group={conv.type === 3 ? 'broadcast' : conv.type === 2 ? 'group' : null} />
        <span className="detail-panel__type-badge">{typeLabel}</span>
      </div>

      {error ? <div className="gm-error">{error}</div> : null}

      {!isGroup ? (
        /* 单聊=名片（PIM-05：非群聊仅元信息） */
        <div className="detail-panel__cards">
          <div className="detail-panel__card">
            <div className="detail-panel__kv">
              <span className="detail-panel__key">
                <Tag size={14} /> 类型
              </span>
              <span>{typeLabel}</span>
            </div>
            <div className="detail-panel__kv">
              <span className="detail-panel__key">
                <Users size={14} /> 成员数
              </span>
              <span>{conv.memberCount}</span>
            </div>
            <div className="detail-panel__kv">
              <span className="detail-panel__key">
                <ScrollText size={14} /> 状态
              </span>
              <span className={`status-badge ${conv.status === 1 ? 'status-badge--ok' : 'status-badge--off'}`}>
                {conv.status === 1 ? '活跃' : '已解散（只读）'}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="detail-panel__cards">
            <div className="detail-panel__card">
              <div className="detail-panel__kv">
                <span className="detail-panel__key">
                  <Users size={14} /> 成员
                </span>
                <span>
                  {conv.memberCount}
                  {conv.type === 2 ? ' / 500' : ' / 5000'}
                </span>
              </div>
              <div className="detail-panel__kv">
                <span className="detail-panel__key">
                  <Shield size={14} /> 我的角色
                </span>
                <span>{ROLE_LABEL[myRole ?? 3]}</span>
              </div>
            </div>
          </div>

          {/* 四 tab（PIM-05） */}
          <div className="gm-tabs" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                className={`gm-tab${tab === t.key ? ' gm-tab--active' : ''}`}
                onClick={() => setTab(t.key)}
              >
                <t.icon size={14} />
                {t.label}
              </button>
            ))}
          </div>

          <div className="gm-tab-body">
            {tab === 'info' ? (
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
              />
            ) : tab === 'members' ? (
              <MembersTab
                conv={conv}
                members={detail}
                myUid={myUid}
                myRole={myRole}
                busy={busy}
                addUids={addUids}
                setAddUids={setAddUids}
                onAdd={() => {
                  const uids = addUids.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
                  if (uids.length === 0) return;
                  void run(async () => {
                    await memberAdd(conv.id, uids);
                    setAddUids('');
                  });
                }}
                onRemove={(uid) => void run(() => memberRemove(conv.id, uid))}
                onRole={(uid, role) => void run(() => memberRole(conv.id, uid, role))}
                onTransferMember={(uid) => void run(() => memberRole(conv.id, uid, 1))}
                onMute={(uid, until) =>
                  void run(() => convSetting(conv.id, { mute_member: { uid, until } }))
                }
              />
            ) : tab === 'setting' ? (
              <SettingTab conv={conv} busy={busy} onPatch={(patch) => void run(() => convSetting(conv.id, patch))} />
            ) : (
              <AnnouncementTab
                conv={conv}
                announcement={groupAnnouncement}
                busy={busy}
                canEdit={isMgr || myRole === 4}
                onSubmit={(text) => void run(() => convSetting(conv.id, { announcement: text }))}
              />
            )}
          </div>
        </>
      )}
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
}: {
  conv: Conversation;
  members: ConversationMember[];
  myUid: string;
  myRole?: MemberRole;
  busy: boolean;
  onQuit: () => void;
  onDissolve: () => void;
  onTransfer: (uid: string) => void;
}) {
  const [confirm, setConfirm] = useState<'quit' | 'dissolve' | null>(null);
  const [transferUid, setTransferUid] = useState('');
  const owner = members.find((m) => m.role === 1);
  const iAmOwner = myRole === 1;
  const muteAll = conv.groupSetting?.muteAllUntil ?? 0;

  return (
    <div className="gm-section">
      <div className="detail-panel__kv">
        <span className="detail-panel__key">
          <Tag size={14} /> 群名
        </span>
        <span>{conv.name}</span>
      </div>
      <div className="detail-panel__kv">
        <span className="detail-panel__key">
          <Hash size={14} /> 群主
        </span>
        <span>{owner ? `${owner.displayName}（${owner.uid === myUid ? '我' : owner.uid}）` : '—'}</span>
      </div>
      <div className="detail-panel__kv">
        <span className="detail-panel__key">
          <ScrollText size={14} /> 状态
        </span>
        <span className={`status-badge ${conv.status === 1 ? 'status-badge--ok' : 'status-badge--off'}`}>
          {conv.status === 1 ? '活跃' : '已解散（只读）'}
        </span>
      </div>
      {muteAll > Date.now() ? (
        <div className="detail-panel__kv">
          <span className="detail-panel__key">
            <VolumeX size={14} /> 全员禁言
          </span>
          <span>至 {formatMuteUntil(muteAll)}</span>
        </div>
      ) : null}

      {/* 转让（owner，危险确认，D01 §8） */}
      {iAmOwner && conv.status === 1 ? (
        <div className="gm-op">
          <div className="gm-op__label">转让群主</div>
          <div className="bbw-input">
            <input
              placeholder="目标成员 uid"
              value={transferUid}
              onChange={(e) => setTransferUid(e.target.value)}
              data-testid="transfer-uid"
            />
          </div>
          <Button
            variant="secondary"
            disabled={busy || !transferUid.trim()}
            onClick={() => {
              if (window.confirm(`确认将群主转让给 ${transferUid.trim()}？转让后你变为普通成员`)) {
                onTransfer(transferUid.trim());
                setTransferUid('');
              }
            }}
          >
            转让
          </Button>
        </div>
      ) : null}

      {conv.status === 1 && !iAmOwner ? (
        <div className="gm-op">
          {confirm === 'quit' ? (
            <div className="gm-confirm">
              <span>确认退出该群？</span>
              <Button variant="danger" disabled={busy} onClick={onQuit}>
                确认退群
              </Button>
              <Button variant="text" onClick={() => setConfirm(null)}>
                取消
              </Button>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setConfirm('quit')}>
              退出群聊
            </Button>
          )}
        </div>
      ) : null}

      {iAmOwner && conv.status === 1 ? (
        <div className="gm-op">
          {confirm === 'dissolve' ? (
            <div className="gm-confirm">
              <span>解散后不可恢复，确认解散？</span>
              <Button variant="danger" disabled={busy} onClick={onDissolve}>
                确认解散
              </Button>
              <Button variant="text" onClick={() => setConfirm(null)}>
                取消
              </Button>
            </div>
          ) : (
            <Button variant="danger" onClick={() => setConfirm('dissolve')}>
              解散群聊
            </Button>
          )}
        </div>
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
  addUids,
  setAddUids,
  onAdd,
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
  addUids: string;
  setAddUids: (v: string) => void;
  onAdd: () => void;
  onRemove: (uid: string) => void;
  onRole: (uid: string, role: 2 | 3) => void;
  /** 转让群主（role=1，危险确认后调用） */
  onTransferMember: (uid: string) => void;
  onMute: (uid: string, until: number) => void;
}) {
  const iAmOwner = myRole === 1;
  const iAmMgr = myRole === 1 || myRole === 2;
  const muted = (m: ConversationMember) => (m.muteUntil ?? 0) > Date.now();

  return (
    <div className="gm-section">
      {/* 添加成员：手输 uid 列表（正式版接通讯录选人，登记） */}
      {iAmMgr && conv.status === 1 ? (
        <div className="gm-op" data-testid="add-member">
          <div className="gm-op__label">添加成员（uid，逗号分隔）</div>
          <div className="bbw-input">
            <input
              placeholder="如 10003, 10004"
              value={addUids}
              onChange={(e) => setAddUids(e.target.value)}
              data-testid="add-member-uids"
            />
          </div>
          <Button variant="primary" disabled={busy || !addUids.trim()} onClick={onAdd}>
            添加
          </Button>
        </div>
      ) : null}

      <div className="gm-members">
        {members.map((m) => (
          <div className="gm-member" key={m.uid} data-uid={m.uid}>
            <Avatar name={m.displayName} size={32} />
            <div className="gm-member__main">
              <span className="gm-member__name">
                {m.uid === myUid ? `${m.displayName}（我）` : m.displayName}
                {m.role !== 3 ? <span className={`gm-member__role gm-member__role--${m.role}`}>{ROLE_LABEL[m.role]}</span> : null}
                {muted(m) ? <span className="gm-member__muted-tag">禁言中</span> : null}
              </span>
              <span className="gm-member__uid">{m.uid}</span>
            </div>
            {iAmMgr && m.uid !== myUid && conv.status === 1 ? (
              <div className="gm-member__ops">
                {/* admin 不能动 owner/admin（服务端矩阵兜底 3015） */}
                {iAmOwner ? (
                  <>
                    <button type="button" className="gm-op-btn" disabled={busy} onClick={() => onRole(m.uid, m.role === 2 ? 3 : 2)}>
                      {m.role === 2 ? '取消管理员' : '设为管理员'}
                    </button>
                    <button
                      type="button"
                      className="gm-op-btn gm-op-btn--danger"
                      disabled={busy}
                      onClick={() => window.confirm(`确认将群主转让给 ${m.displayName}？`) && onTransferMember(m.uid)}
                    >
                      转让
                    </button>
                  </>
                ) : null}
                {/* 禁言矩阵（04 篇 §4.5.1）：admin 仅 member 级；owner 可 member/admin（服务端兜底 3015） */}
                {m.role === 3 || (iAmOwner && m.role === 2) ? (
                  muted(m) ? (
                    <button type="button" className="gm-op-btn" disabled={busy} onClick={() => onMute(m.uid, 0)}>
                      解除禁言
                    </button>
                  ) : (
                    MUTE_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        className="gm-op-btn"
                        disabled={busy}
                        onClick={() => onMute(m.uid, Date.now() + p.ms)}
                        title={`禁言 ${p.label}`}
                      >
                        禁言{p.label}
                      </button>
                    ))
                  )
                ) : null}
                <button
                  type="button"
                  className="gm-op-btn gm-op-btn--danger"
                  disabled={busy}
                  onClick={() => window.confirm(`确认将 ${m.displayName} 移出群聊？`) && onRemove(m.uid)}
                >
                  移出
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
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
  const muteAllOn = (gs?.muteAllUntil ?? 0) > Date.now();

  return (
    <div className="gm-section">
      <div className="gm-field">
        <label className="gm-field__label">群名（≤50 字）</label>
        <div className="gm-field__row">
          <div className="bbw-input">
            <input value={name} onChange={(e) => setName(e.target.value)} data-testid="group-name-input" />
          </div>
          <Button variant="secondary" disabled={busy || !name.trim() || name === conv.name} onClick={() => onPatch({ name: name.trim() })}>
            改名
          </Button>
        </div>
      </div>

      <div className="gm-field">
        <label className="gm-field__label">入群方式</label>
        <select
          className="gm-select"
          value={gs?.joinMode ?? 1}
          disabled={busy}
          onChange={(e) => onPatch({ join_mode: Number(e.target.value) as 1 | 2 | 3 })}
        >
          <option value={1}>直接加入</option>
          <option value={2}>需要审批</option>
          <option value={3}>仅邀请</option>
        </select>
      </div>

      <div className="gm-field">
        <label className="gm-field__label">邀请权限</label>
        <select
          className="gm-select"
          value={gs?.invitePolicy ?? 1}
          disabled={busy}
          onChange={(e) => onPatch({ invite_policy: Number(e.target.value) as 1 | 2 })}
        >
          <option value={1}>全员可邀</option>
          <option value={2}>仅管理员</option>
        </select>
      </div>

      <div className="gm-field">
        <label className="gm-field__label">@全体权限（3014）</label>
        <select
          className="gm-select"
          value={gs?.mentionAllPolicy ?? 2}
          disabled={busy}
          onChange={(e) => onPatch({ mention_all_policy: Number(e.target.value) as 1 | 2 | 3 })}
        >
          <option value={1}>全员可用</option>
          <option value={2}>仅管理员</option>
          <option value={3}>禁用</option>
        </select>
      </div>

      <div className="gm-field">
        <label className="gm-field__label">全员禁言（owner/admin 豁免）</label>
        <div className="gm-field__row">
          <select className="gm-select" disabled={busy || muteAllOn} defaultValue={3600_000} data-testid="mute-all-select">
            <option value={600_000}>10 分钟</option>
            <option value={3600_000}>1 小时</option>
            <option value={24 * 3600_000}>1 天</option>
          </select>
          {muteAllOn ? (
            <Button variant="secondary" disabled={busy} onClick={() => onPatch({ mute_all_until: 0 })}>
              解除全员禁言
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                const sel = document.querySelector<HTMLSelectElement>('[data-testid="mute-all-select"]');
                onPatch({ mute_all_until: Date.now() + Number(sel?.value ?? 3600_000) });
              }}
            >
              开启
            </Button>
          )}
        </div>
      </div>

      <div className="gm-field">
        <label className="gm-field__label">新成员可见历史消息</label>
        <Button variant="secondary" disabled={busy} onClick={() => onPatch({ history_visible: !(gs?.historyVisible ?? true) })}>
          {gs?.historyVisible ?? true ? '当前：可见（点击关闭）' : '当前：不可见（点击开启）'}
        </Button>
      </div>
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(announcement ?? '');

  useEffect(() => {
    setDraft(announcement ?? '');
  }, [announcement]);

  return (
    <div className="gm-section">
      {announcement ? (
        <div className="gm-announcement" data-testid="announcement-text">
          <div className="gm-announcement__body">{announcement}</div>
          {conv.groupSetting?.announcementTs ? (
            <div className="gm-announcement__ts">发布于 {formatMuteUntil(conv.groupSetting.announcementTs)}</div>
          ) : null}
        </div>
      ) : (
        <div className="gm-empty">暂无公告{canEdit ? '，点击下方发布' : ''}</div>
      )}

      {canEdit && conv.status === 1 ? (
        editing ? (
          <div className="gm-op">
            <div className="gm-op__label">编辑公告（≤2000 字）</div>
            <textarea
              className="gm-textarea"
              rows={5}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              data-testid="announcement-input"
              placeholder="发布群公告…"
            />
            <div className="gm-field__row">
              <Button
                variant="primary"
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
