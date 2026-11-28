/**
 * 登录页账号选择器（QQ 式，2026-11-27 重构自 UserPicker 搜人下拉）：
 * - 账号框回归真实受控文本（autoComplete="username"，手输工号/邮箱/手机号可直接登录，
 *   密码管理器自动填充可感知——旧版选中存对象不落文本，填充必然失效）
 * - 聚焦/尾缀箭头弹下拉，二段式：「最近登录」历史账号区（首字圆徽+姓名+工号+相对时间，
 *   hover × 删除，按输入文本过滤）在上，「组织内搜索」结果在下（沿用旧检索：防抖
 *   300ms、触底翻页、工号/拼音/名字模糊）；文本为空不发请求只显历史
 * - 键盘：↑↓ 跨两段扁平导航、Enter 选中、Esc 关闭；外点关闭
 * 旧口径存档（2026-11-12 用户裁决）：账号由搜人选择、卡片两行制（工号+名字/组织链路）、
 * 加载失败显式报错+重试——检索/翻页/键盘逻辑全部保留。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Input, Typography, theme } from 'antd';
import { ChevronDown, Search, X } from 'lucide-react';
import { ApiError } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { apiSearchUsers, type UserCard } from '../api/auth';
import type { RememberedAccount } from '../bridge/accounts';

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 300;

/** 相对时间标签：今天显时分，同年显月日，跨年带年份 */
function lastLoginText(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const md = `${d.getMonth() + 1}-${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

export function AccountPicker({
  account,
  onAccountChange,
  selected,
  onSelect,
  remembered,
  onPickRemembered,
  onRemoveRemembered,
  disabled,
}: {
  /** 受控文本（选中组织用户时展示「姓名（工号）」，手改即弃选中） */
  account: string;
  onAccountChange: (v: string) => void;
  selected: UserCard | null;
  onSelect: (u: UserCard | null) => void;
  /** 历史账号（壳侧记忆；非 Tauri 恒空 → 纯组织搜索退化） */
  remembered: RememberedAccount[];
  onPickRemembered: (a: RememberedAccount) => void;
  onRemoveRemembered: (a: RememberedAccount) => void;
  disabled?: boolean;
}) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<UserCard[]>([]);
  const [cursor, setCursor] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 请求代际：新检索使旧响应作废（防抖/翻页竞态）
  const seqRef = useRef(0);

  const display = selected ? `${selected.display_name}（${selected.employee_no}）` : account;

  // 历史区按输入过滤（姓名/工号包含即中）；空文本全量展示
  const filteredHistory = useMemo(() => {
    const q = account.trim().toLowerCase();
    if (!q) return remembered;
    return remembered.filter((a) => a.name.toLowerCase().includes(q) || a.account.toLowerCase().includes(q));
  }, [remembered, account]);

  // 组织检索区：仅非空文本出现（空文本不发请求，历史区当主角）
  const showOrg = account.trim().length > 0;
  const historyLen = filteredHistory.length;
  const flatLen = historyLen + (showOrg ? items.length : 0);

  const search = useCallback(async (q: string) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setLoadError(false);
    try {
      const page = await apiSearchUsers(q, undefined, PAGE_SIZE);
      if (seq !== seqRef.current) return;
      setItems(page.items);
      setCursor(page.next_cursor);
      setActiveIdx(page.items.length > 0 ? 0 : -1);
    } catch (e) {
      if (seq !== seqRef.current) return;
      e instanceof ApiError && e.claim(); // 下拉内 loadError 自展示——认领防双显
      setItems([]);
      setCursor('');
      setActiveIdx(-1);
      setLoadError(true); // 404=旧服务端未重启 / 5xx=故障——不再伪装成空列表
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || loading || !cursor) return;
    const seq = seqRef.current;
    const q = account.trim();
    if (!q) return;
    setLoadingMore(true);
    try {
      const page = await apiSearchUsers(q, cursor, PAGE_SIZE);
      if (seq !== seqRef.current) return;
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.next_cursor);
    } catch {
      /* 触底加载失败静默——下次滚动重试 */
    } finally {
      if (seq === seqRef.current) setLoadingMore(false);
    }
  }, [cursor, loading, loadingMore, account]);

  // 防抖检索（仅非空文本；清空=清结果回历史区）
  useEffect(() => {
    if (!open) return;
    const q = account.trim();
    if (!q) {
      setItems([]);
      setCursor('');
      setLoadError(false);
      return;
    }
    const timer = setTimeout(() => void search(q), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [account, open, search]);

  // 外点关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // 高亮行滚入可视区（键盘导航配套）+ 越界收敛
  useEffect(() => {
    setActiveIdx((i) => (flatLen > 0 ? Math.min(Math.max(i, 0), flatLen - 1) : -1));
  }, [flatLen]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const pickOrg = (u: UserCard) => {
    onSelect(u);
    onAccountChange('');
    setOpen(false);
  };

  const pickAt = (idx: number) => {
    if (idx < historyLen) onPickRemembered(filteredHistory[idx]);
    else pickOrg(items[idx - historyLen]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, flatLen - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && activeIdx < flatLen) pickAt(activeIdx);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) void loadMore();
  };

  const hintStyle: React.CSSProperties = { padding: '8px 12px', fontSize: token.fontSizeSM, color: token.colorTextSecondary };

  // 历史行：首字圆徽 + 姓名（工号）+ 上次登录时间 + 删除钮
  const renderHistory = () =>
    filteredHistory.map((a, i) => (
      <div
        key={`h-${a.account}`}
        data-idx={i}
        role="button"
        tabIndex={-1}
        onMouseEnter={() => setActiveIdx(i)}
        onClick={() => onPickRemembered(a)}
        data-testid={`login-history-option-${a.account}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          cursor: 'pointer',
          background: i === activeIdx ? token.colorPrimaryBg : 'transparent',
        }}
      >
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            width: 32,
            height: 32,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: token.colorPrimaryBg,
            color: token.colorPrimary,
            fontWeight: 600,
            fontSize: 14,
          }}
        >
          {(a.name || a.account).slice(0, 1)}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontWeight: 500 }}>{a.name || a.account}</span>
            <Typography.Text code style={{ fontSize: token.fontSizeSM }}>
              {a.account}
            </Typography.Text>
          </span>
          <span style={{ display: 'block', fontSize: token.fontSizeSM, color: token.colorTextTertiary }}>
            上次登录 {lastLoginText(a.lastLoginAt)}
          </span>
        </span>
        <span
          role="button"
          aria-label={`删除账号记忆 ${a.account}`}
          data-testid={`login-history-remove-${a.account}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemoveRemembered(a);
          }}
          style={{ flexShrink: 0, display: 'flex', padding: 4, borderRadius: token.borderRadiusSM, color: token.colorTextTertiary, cursor: 'pointer' }}
        >
          <X size={14} aria-hidden />
        </span>
      </div>
    ));

  return (
    <div style={{ position: 'relative' }} ref={rootRef}>
      <Input
        size="large"
        value={display}
        disabled={disabled}
        placeholder="工号 / 邮箱 / 手机号"
        autoComplete="username"
        allowClear={!!selected}
        data-testid="login-user-search"
        prefix={<Search size={15} aria-hidden />}
        suffix={
          <span
            role="button"
            aria-label="展开历史账号"
            data-testid="login-account-caret"
            onMouseDown={(e) => e.preventDefault()} // 点击箭头不丢焦点，下拉不被外点逻辑收走
            onClick={() => setOpen((v) => !v)}
            style={{ display: 'flex', cursor: 'pointer', color: token.colorTextTertiary }}
          >
            <ChevronDown
              size={15}
              aria-hidden
              style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
            />
          </span>
        }
        onChange={(e) => {
          onAccountChange(e.target.value);
          if (selected) onSelect(null); // 手改文本=放弃已选，回到文本态
          setOpen(true);
        }}
        onFocus={() => setOpen(true)} // QQ 行为：聚焦即弹历史账号
        onKeyDown={onKeyDown}
      />
      {open ? (
        <div
          data-testid="login-user-dropdown"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            zIndex: token.zIndexPopupBase,
            background: token.colorBgElevated,
            borderRadius: token.borderRadiusLG,
            boxShadow: token.boxShadowSecondary,
            overflow: 'hidden',
          }}
        >
          <div style={{ maxHeight: 260, overflowY: 'auto' }} onScroll={onScroll} ref={listRef}>
            {historyLen > 0 ? <div style={{ ...hintStyle, fontWeight: 500 }}>最近登录</div> : null}
            {renderHistory()}
            {historyLen > 0 && showOrg ? (
              <div style={{ ...hintStyle, fontWeight: 500, borderTop: `1px solid ${token.colorSplit}` }}>组织内搜索</div>
            ) : null}
            {showOrg ? (
              <>
                {loadError ? (
                  <div style={{ ...hintStyle, display: 'flex', alignItems: 'center' }}>
                    用户列表加载失败（服务端可能未重启到新版）
                    <Button variant="secondary" size="small" style={{ marginLeft: 8 }} onClick={() => void search(account.trim())}>
                      重试
                    </Button>
                  </div>
                ) : items.length === 0 && !loading ? (
                  <div style={hintStyle}>无匹配用户（支持工号 / 拼音 / 名字）</div>
                ) : null}
                {items.map((u, i) => {
                  const idx = historyLen + i;
                  return (
                    <button
                      type="button"
                      key={u.employee_no}
                      data-idx={idx}
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => pickOrg(u)}
                      data-testid={`login-user-option-${u.employee_no}`}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 12px',
                        border: 'none',
                        background: idx === activeIdx ? token.colorPrimaryBg : 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <Typography.Text code>{u.employee_no}</Typography.Text>
                        <span style={{ fontWeight: 500 }}>{u.display_name}</span>
                      </span>
                      <span
                        style={{
                          display: 'block',
                          fontSize: token.fontSizeSM,
                          color: token.colorTextTertiary,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                        title={u.org_path || '未挂部门'}
                      >
                        {u.org_path || '未挂部门'}
                      </span>
                    </button>
                  );
                })}
                {loadingMore ? <div style={hintStyle}>加载中…</div> : null}
                {!cursor && items.length > 0 ? <div style={hintStyle}>已到底</div> : null}
              </>
            ) : null}
            {flatLen === 0 && !loading && !loadError ? (
              <div style={hintStyle}>输入工号 / 拼音 / 名字搜索组织内账号</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
