/**
 * 知识库壳页（D24 真机修正轮 2026-11-13）：左=文章树（两维度专栏嵌套），
 * 右=tab 页签容器——首页 tab 固定第 0 位不可关，点开的文章各占一 tab。
 * 路由驱动：/kb=首页 tab、/kb/d/:docId=打开/激活对应 tab（深链/刷新恢复当前）；
 * tab 列表为会话级（刷新重建，登记）。搜索页仍独立路由（全屏语义）。
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FilePlus2, FolderPlus, Home, X } from 'lucide-react';
import { fetchDoc } from '../api/kb';
import { ArticleTree } from '../components/ArticleTree';
import { ArticlePanel } from '../components/ArticlePanel';
import { CreateDocDialog } from '../components/CreateDocDialog';
import { CreateDirDialog } from '../components/CreateDirDialog';
import { useKbTabs } from '../store/kbTabs';
import { qk } from '../../../shared/api/keys';
import { KbHomePage } from './KbHomePage';

export function KbShellPage() {
  const { docId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // 创建文章/目录弹窗（修正轮二：页面恢复写入入口——用户拍板修订 D24 原零写入口径）
  const [dlg, setDlg] = useState<null | 'doc' | 'dir'>(null);
  const tabs = useKbTabs((s) => s.tabs);
  const activeKey = useKbTabs((s) => s.activeKey);
  const open = useKbTabs((s) => s.open);
  const setActive = useKbTabs((s) => s.setActive);
  const close = useKbTabs((s) => s.close);

  // 路由 → tab 状态：文章深链打开/激活（标题优先取缓存，miss 时拉详情补）
  useEffect(() => {
    if (!docId) {
      setActive('home');
      return;
    }
    if (tabs.some((t) => t.key === docId)) {
      setActive(docId);
      return;
    }
    const cached = qc.getQueryData<{ title: string }>(qk.kb.doc(docId));
    if (cached?.title) {
      open(docId, cached.title);
      return;
    }
    let alive = true;
    void fetchDoc(docId)
      .then((d) => {
        if (alive) open(docId, d.title);
      })
      .catch(() => {
        if (alive) open(docId, '文章');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  /** tab → 路由（地址栏跟随，可深链） */
  const goTab = (key: string) => {
    setActive(key);
    navigate(key === 'home' ? '/kb' : `/kb/d/${key}`);
  };

  const onCloseTab = (key: string) => {
    const next = close(key);
    if (next !== activeKey) navigate(next === 'home' ? '/kb' : `/kb/d/${next}`);
  };

  /** 左树点击文章：开 tab + 路由跟随 */
  const onOpenDoc = (id: string, title: string) => {
    open(id, title);
    navigate(`/kb/d/${id}`);
  };

  return (
    <div className="kb-shell" data-testid="kb-shell">
      <aside className="kb-shell__tree">
        <div className="kb-shell__tree-head">
          <span>文章树</span>
          <span className="kb-shell__tree-actions">
            <button type="button" className="kb-shell__tree-btn" title="新建文章" data-testid="kb-btn-create-doc" onClick={() => setDlg('doc')}>
              <FilePlus2 size={13} /> 文章
            </button>
            <button type="button" className="kb-shell__tree-btn" title="新建目录（专栏）" data-testid="kb-btn-create-dir" onClick={() => setDlg('dir')}>
              <FolderPlus size={13} /> 目录
            </button>
          </span>
        </div>
        <div className="kb-shell__tree-body">
          <ArticleTree onOpenDoc={onOpenDoc} />
        </div>
      </aside>

      {dlg === 'doc' ? (
        <CreateDocDialog
          onClose={() => setDlg(null)}
          onCreated={(doc) => {
            setDlg(null);
            open(doc.id, doc.title);
            navigate(`/kb/d/${doc.id}`);
          }}
        />
      ) : null}
      {dlg === 'dir' ? <CreateDirDialog onClose={() => setDlg(null)} /> : null}
      <div className="kb-shell__main">
        <div className="kb-tabs" role="tablist" data-testid="kb-tabs">
          {tabs.map((t) => (
            <div
              key={t.key}
              role="tab"
              aria-selected={t.key === activeKey}
              className={`kb-tabs__item${t.key === activeKey ? ' kb-tabs__item--active' : ''}${t.key === 'home' ? ' kb-tabs__item--home' : ''}`}
              data-testid="kb-tab"
              onClick={() => goTab(t.key)}
            >
              {t.key === 'home' ? <Home size={12} className="kb-tabs__home-icon" /> : null}
              <span className="kb-tabs__label" title={t.title}>
                {t.title}
              </span>
              {t.key !== 'home' ? (
                <button
                  type="button"
                  className="kb-tabs__close"
                  title="关闭"
                  data-testid="kb-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(t.key);
                  }}
                >
                  <X size={11} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <div className="kb-shell__content">
          {/* 首页 tab=原 KbHomePage 整页复用（概览卡/大搜索/榜单三列/最近查看） */}
          {activeKey === 'home' ? <KbHomePage /> : <ArticlePanel docId={activeKey} />}
        </div>
      </div>
    </div>
  );
}
