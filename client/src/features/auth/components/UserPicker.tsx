/**
 * 登录页搜人选择器（2026-11-12 用户裁决：账号不再手填——搜工号/拼音/名字选人，
 * 选中自动填充工号）：
 * - 下拉卡片：工号 + 姓名 + 组织链路（xx公司/a部门/xx组），单卡一行不占高
 * - 滚动分页：触底加载下一页（cursor=当页末条工号），搜索态与翻页叠加
 * - 键盘：↑↓ 移动高亮、Enter 选中、Esc 关闭；防抖 300ms 检索
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
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
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<UserCard[]>([]);
  const [cursor, setCursor] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 请求代际：新检索使旧响应作废（防抖/翻页竞态）
  const seqRef = useRef(0);

  const display = selected ? `${selected.display_name}（${selected.employee_no}）` : text;

  const search = useCallback(async (q: string) => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const page = await apiSearchUsers(q, undefined, PAGE_SIZE);
      if (seq !== seqRef.current) return;
      setItems(page.items);
      setCursor(page.next_cursor);
      setActiveIdx(page.items.length > 0 ? 0 : -1);
    } catch {
      if (seq !== seqRef.current) return;
      setItems([]);
      setCursor('');
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

  return (
    <div className="user-picker" ref={rootRef}>
      <div className="bbw-input bbw-input--search user-picker__input">
        <Search size={14} aria-hidden />
        <input
          value={display}
          disabled={disabled}
          placeholder="输入工号 / 拼音 / 名字搜索选择账号"
          autoComplete="off"
          data-testid="login-user-search"
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
      </div>
      {open ? (
        <div className="user-picker__dropdown" data-testid="login-user-dropdown">
          <div className="user-picker__list" onScroll={onScroll} ref={listRef}>
            {items.length === 0 && !loading ? (
              <div className="user-picker__empty">无匹配用户{cursor ? '' : '（支持工号 / 拼音 / 名字）'}</div>
            ) : null}
            {items.map((u, i) => (
              <button
                type="button"
                key={u.employee_no}
                data-idx={i}
                className={`user-picker__card${i === activeIdx ? ' user-picker__card--active' : ''}`}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => pick(u)}
                data-testid={`login-user-option-${u.employee_no}`}
              >
                <span className="user-picker__empno">{u.employee_no}</span>
                <span className="user-picker__name">{u.display_name}</span>
                <span className="user-picker__org" title={u.org_path || '未挂部门'}>
                  {u.org_path || '未挂部门'}
                </span>
              </button>
            ))}
            {loadingMore ? <div className="user-picker__more">加载中…</div> : null}
            {!cursor && items.length > 0 ? <div className="user-picker__more">已到底</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
