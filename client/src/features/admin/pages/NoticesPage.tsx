/**
 * 公告发布（D10 PAD-15）：发布表单（标题/正文，全员通知中心触达）+ 历史列表
 * （触达快照 reach）。发布通道=kind=announcement 系统公告分组（PIM-09 既有）。
 */

import { useCallback, useEffect, useState } from 'react';
import { Megaphone } from 'lucide-react';
import { errText } from '../../../shared/api/http';
import { fetchNotices, publishNotice, type AdminNotice } from '../api/admin';

export function NoticesPage() {
  const [items, setItems] = useState<AdminNotice[] | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const page = await fetchNotices({ limit: 50 });
      setItems(page.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const publish = async () => {
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      await publishNotice(title.trim(), content.trim());
      setTitle('');
      setContent('');
      setOk(true);
      await reload();
    } catch (e) {
      setError(errText(e, '发布失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-page__section" data-testid="admin-notices">
      <div className="admin-page__head">
        <h2>公告发布</h2>
      </div>
      {error ? <div className="admin-page__error">{error}</div> : null}
      {ok ? <div className="admin-notice__ok">已发布并广播全员通知中心</div> : null}

      <div className="admin-notice__form">
        <input
          className="bbw-input"
          placeholder="标题（≤100 字）"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="notice-title-input"
        />
        <textarea
          className="gm-textarea"
          rows={5}
          placeholder="正文（≤4000 字；全员将通过通知中心「系统公告」分组收到）"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          data-testid="notice-content-input"
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !title.trim() || !content.trim()}
          onClick={() => void publish()}
          data-testid="notice-publish-btn"
        >
          <Megaphone size={14} /> {busy ? '发布中…' : '发布并广播'}
        </button>
      </div>

      <div className="admin-notice__history">
        <h3>历史公告</h3>
        {items === null ? (
          <div className="admin-page__empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="admin-page__empty">暂无公告</div>
        ) : (
          items.map((n) => (
            <div className="admin-notice__item" key={n.id} data-testid="notice-item">
              <div className="admin-notice__item-head">
                <strong>{n.title}</strong>
                <span className="admin-notice__reach" title="发布时全员触达快照">
                  触达 {n.reach}
                </span>
              </div>
              <pre className="admin-notice__content">{n.content}</pre>
              <div className="admin-notice__ts">{new Date(n.created_at).toLocaleString()}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
