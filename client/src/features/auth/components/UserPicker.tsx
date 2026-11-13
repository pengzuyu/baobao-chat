/**
 * 登录页搜人选择器（2026-11-12 用户裁决：账号不再手填——搜工号/拼音/名字选人，
 * 选中自动填充工号）：
 * - 输入框=antd Input size=large（与口令框同款风格）；下拉卡片两行制：
 *   第一行 工号+名字，第二行 组织链路（xx公司/a部门/xx组）
 * - 滚动分页：触底加载下一页（cursor=当页末条工号），搜索态与翻页叠加
 * - 键盘：↑↓ 移动高亮、Enter 选中、Esc 关闭；防抖 300ms 检索
 * - 加载失败显式报错+重试（旧服务端 404 不再伪装成「无匹配用户」）
 * D26-O3：user-picker 自研样式退役——下拉壳/两行卡改内联 style + antd 主题 token，
 * 重试钮换 shared Button；检索/翻页/键盘逻辑不动。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Input, Typography, theme } from 'antd';
import { Search } from 'lucide-react';
import { ApiError } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { apiSearchUsers, type UserCard } from '../api/auth';

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 300;

export function UserPicker({
  selected,
  onSelect,
  disabled,
}: {
  selected: UserCard | null;
  onSelect: (u: UserCard | null) => void;
  disabled?: boolean;
}) {
  const { token } = theme.useToken();
  const [text, setText] = useState('');
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

  const display = selected ? `${selected.display_name}（${selected.employee_no}）` : text;

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
    setLoadingMore(true);
    try {
      const page = await apiSearchUsers(text.trim(), cursor, PAGE_SIZE);
      if (seq !== seqRef.current) return;
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.next_cursor);
    } catch {
      /* 触底加载失败静默——下次滚动重试 */
    } finally {
      if (seq === seqRef.current) setLoadingMore(false);
    }
  }, [cursor, loading, loadingMore, text]);

  // 防抖检索（含清空回到首页）；选中态下改文本=重新检索并清除选中
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void search(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, open, search]);

  // 外点关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pick = (u: UserCard) => {
    onSelect(u);
    setText('');
    setOpen(false);
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
      setActiveIdx((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && items[activeIdx]) pick(items[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  // 高亮行滚入可视区（键盘导航配套）
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) void loadMore();
  };

  const hintStyle: React.CSSProperties = { padding: '8px 12px', fontSize: token.fontSizeSM, color: token.colorTextSecondary };

  return (
    <div style={{ position: 'relative' }} ref={rootRef}>
      <Input
        size="large"
        value={display}
        disabled={disabled}
        placeholder="输入工号 / 拼音 / 名字搜索选择账号"
        autoComplete="off"
        allowClear={!!selected}
        data-testid="login-user-search"
        prefix={<Search size={15} aria-hidden />}
        onChange={(e) => {
          setText(e.target.value);
          if (selected) onSelect(null); // 手改文本=放弃已选，回到检索态
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          if (selected) onSelect(null);
        }}
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
            {loadError ? (
              <div style={{ ...hintStyle, display: 'flex', alignItems: 'center' }}>
                用户列表加载失败（服务端可能未重启到新版）
                <Button variant="secondary" size="small" style={{ marginLeft: 8 }} onClick={() => void search(text.trim())}>
                  重试
                </Button>
              </div>
            ) : items.length === 0 && !loading ? (
              <div style={hintStyle}>无匹配用户（支持工号 / 拼音 / 名字）</div>
            ) : null}
            {items.map((u, i) => (
              <button
                type="button"
                key={u.employee_no}
                data-idx={i}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => pick(u)}
                data-testid={`login-user-option-${u.employee_no}`}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 12px',
                  border: 'none',
                  background: i === activeIdx ? token.colorPrimaryBg : 'transparent',
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
            ))}
            {loadingMore ? <div style={hintStyle}>加载中…</div> : null}
            {!cursor && items.length > 0 ? <div style={hintStyle}>已到底</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
