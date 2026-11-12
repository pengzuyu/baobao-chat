/**
 * 全局搜索面板（PIM-07 服务端态简版，D03 §3.7/INT-IM-21）：
 * - 列表头搜索框激活（点击/⌘K 聚焦）→ 输入≥1 字防抖 400ms 调 GET /messages/search
 * - M3（2026-11-12 用户口径「搜索框找到人然后聊」）：同关键词并行调 GET /org/users，
 *   联系人段（≤5）置顶展示，点人发起单聊直达（onPickPerson → conv.create 幂等）
 * - 下拉结果面板：命中片段高亮（端内 substring，大小写不敏感）+ 会话名 + 发送人 + 日期
 * - 点击 → 跳转会话并定位闪烁（复用 ChatPage locateSeq，经 pendingLocate 交接）
 * - 六态（服务端态简版）：loading shimmer×5 / empty「未找到相关的人或消息」/ error 黄条
 *   「服务端搜索不可用」/ offline 提示仅服务端态可用 / forbidden、degraded 不适用（登记）。
 * 本地 FTS5 态属 Tauri/Rust 侧（D03 L1），本组件不覆盖。
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { Search } from 'lucide-react';
import { ApiError } from '../../../shared/api/http';
import { useConnectionStore } from '../../../shared/store/connection';
import { formatListTime } from '../../../shared/utils/time';
import { digestOf } from '../store/im';
import { searchMessages, type SearchHit } from '../api/im';
import { fetchDirectoryUsers } from '../../contacts/api/contacts';
import type { DirectoryUser } from '../../contacts/api/contacts';
import type { Message } from '../model/types';

/** 防抖窗口（D03 §3.7：输入即搜的服务端态节流） */
const SEARCH_DEBOUNCE_MS = 400;
/** 搜索中态 shimmer 行数（六态 loading=shimmer×5） */
const SEARCH_SHIMMER_ROWS = 5;
/** 联系人段最多展示行数（M3：置顶导流搜人即聊） */
const PEOPLE_MAX_ROWS = 5;

interface SearchPanelProps {
  /** ⌘K 聚焦目标（ChatPage 持有 ref） */
  inputRef: RefObject<HTMLInputElement>;
  /** 选中结果：跳转会话 + 定位（ChatPage 内 navigate + setPendingLocate） */
  onSelect: (hit: SearchHit) => void;
  /** 联系人命中（M3）：点人发起单聊直达（ChatPage 内 conv.create type=1） */
  onPickPerson: (u: DirectoryUser) => void;
}

/** 提取可检索文本（与服务端口径一致：text 取 body.text，其余取 body.name） */
function searchableText(msg: Message): string {
  if (msg.type === 'text' && 'text' in msg.body) return msg.body.text;
  if ('name' in msg.body && typeof msg.body.name === 'string') return msg.body.name;
  return '';
}

/** 命中片段高亮：取首个命中位前后窗口（前 12/后 24 字），大小写不敏感 substring */
function HighlightSnippet({ text, keyword }: { text: string; keyword: string }) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(keyword.toLowerCase());
  if (idx < 0) {
    return <span className="search-hit__snippet">{text.slice(0, 40) || '（无文本预览）'}</span>;
  }
  const start = Math.max(0, idx - 12);
  const end = Math.min(text.length, idx + keyword.length + 24);
  const before = (start > 0 ? '…' : '') + text.slice(start, idx);
  const hit = text.slice(idx, idx + keyword.length);
  const after = text.slice(idx + keyword.length, end) + (end < text.length ? '…' : '');
  return (
    <span className="search-hit__snippet">
      {before}
      <mark className="search-hit__mark" data-testid="search-hit-mark">
        {hit}
      </mark>
      {after}
    </span>
  );
}

export function SearchPanel({ inputRef, onSelect, onPickPerson }: SearchPanelProps) {
  const [keyword, setKeyword] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [people, setPeople] = useState<DirectoryUser[]>([]);
  const seqRef = useRef(0); // 竞态防护：仅采纳最后一次发起的结果
  const online = useConnectionStore((s) => s.status === 'online');

  // 防抖 400ms：≥1 字才发请求；清空即收起
  useEffect(() => {
    const kw = keyword.trim();
    if (kw.length < 1) {
      setHits([]);
      setPeople([]);
      setLoading(false);
      setError(false);
      setOpen(false);
      return;
    }
    setOpen(true);
    setLoading(true);
    setError(false);
    const seq = ++seqRef.current;
    const timer = setTimeout(() => {
      // M3：联系人 + 消息并行检索；联系人失败静默降级（仅消息段承担 error 态）
      void fetchDirectoryUsers({ q: kw, limit: PEOPLE_MAX_ROWS })
        .then((res) => {
          if (seqRef.current !== seq) return;
          setPeople(res.items);
        })
        .catch(() => {
          if (seqRef.current !== seq) return;
          setPeople([]);
        });
      void searchMessages({ keyword: kw, limit: 20 })
        .then((res) => {
          if (seqRef.current !== seq) return;
          setHits(res.items);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (seqRef.current !== seq) return;
          // 9003/9005 → 黄条「服务端搜索不可用」（本地 FTS5 态未接入，简版直接提示）
          setError(err instanceof ApiError || err instanceof Error);
          setHits([]);
          setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [keyword]);

  // Esc 收起
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const kw = keyword.trim();

  return (
    <div className="search-panel" data-testid="search-panel">
      <div className="bbw-input bbw-input--search">
        <Search size={14} aria-hidden />
        <input
          ref={inputRef}
          placeholder="搜索联系人/消息（⌘K）"
          value={keyword}
          data-testid="global-search-input"
          onChange={(e) => setKeyword(e.target.value)}
          onFocus={() => kw.length >= 1 && setOpen(true)}
        />
        <kbd>⌘K</kbd>
      </div>
      {open && kw.length >= 1 ? (
        <div className="search-panel__dropdown" data-testid="search-dropdown">
          {!online ? (
            <div className="search-panel__hint">离线中：服务端搜索不可用（本地索引暂未接入）</div>
          ) : loading ? (
            <div className="search-panel__shimmer" aria-label="搜索中">
              {Array.from({ length: SEARCH_SHIMMER_ROWS }, (_, i) => (
                <div key={i} className="search-panel__shimmer-row" />
              ))}
            </div>
          ) : error ? (
            <div className="search-panel__hint search-panel__hint--warn" data-testid="search-error">
              服务端搜索不可用，请稍后重试
            </div>
          ) : hits.length === 0 && people.length === 0 ? (
            <div className="search-panel__hint" data-testid="search-empty">
              未找到相关的人或消息
            </div>
          ) : (
            <div className="search-panel__list">
              {/* M3 联系人段：置顶导流搜人即聊（点人发起单聊直达） */}
              {people.length > 0 ? (
                <>
                  <div className="search-panel__section">联系人</div>
                  {people.slice(0, PEOPLE_MAX_ROWS).map((u) => (
                    <button
                      key={u.uid}
                      type="button"
                      className="search-hit"
                      data-testid="search-people-hit"
                      onClick={() => {
                        setOpen(false);
                        onPickPerson(u);
                      }}
                    >
                      <span className="search-hit__snippet">
                        {u.display_name}
                        <span className="search-people__empno">{u.employee_no}</span>
                      </span>
                      <span className="search-hit__meta">
                        <span className="search-hit__conv">{u.org_path || '未分组'}</span>
                        <span className="search-hit__time">发消息</span>
                      </span>
                    </button>
                  ))}
                </>
              ) : null}
              {hits.length > 0 ? (
                <>
                  {people.length > 0 ? <div className="search-panel__section">消息</div> : null}
                  {hits.map((hit) => (
                    <button
                      key={hit.msg.msgId}
                      type="button"
                      className="search-hit"
                      data-testid="search-hit"
                      onClick={() => {
                        setOpen(false);
                        onSelect(hit);
                      }}
                    >
                      {hit.msg.status === 2 ? (
                        <span className="search-hit__snippet">已撤回的消息</span>
                      ) : (
                        <HighlightSnippet
                          text={searchableText(hit.msg) || digestOf(hit.msg)}
                          keyword={kw}
                        />
                      )}
                      <span className="search-hit__meta">
                        <span className="search-hit__conv">{hit.convName || '会话'}</span>
                        <span className="search-hit__sender">{hit.senderName}</span>
                        <span className="search-hit__time">{formatListTime(hit.msg.ts)}</span>
                      </span>
                    </button>
                  ))}
                </>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
