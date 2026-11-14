/**
 * 知识库壳页（D24 真机修正轮 2026-11-13）：左=文章树（两维度专栏嵌套），
 * 右=tab 页签容器——首页 tab 固定第 0 位不可关，点开的文章各占一 tab。
 * 路由驱动：/kb=首页 tab、/kb/d/:docId=打开/激活对应 tab（深链/刷新恢复当前）；
 * tab 列表为会话级（刷新重建，登记）。搜索页仍独立路由（全屏语义）。
 * D26-O1：页签条换 antd Tabs（card 式，仅作条用——内容仍由下方条件渲染，
 * 保持「仅活动 tab 挂载」的现有语义）；树头按钮换 antd Button。
 * D26-O1 补充轮：kb-shell 骨架自研类退役——左栏/主区布局内联 style+theme token。
 */

import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button as AntdButton, Flex, Space, Tabs, Typography, theme } from 'antd';
import { FilePlus2, FolderPlus, Home } from 'lucide-react';
import { fetchDoc } from '../api/kb';
import { ArticleTree } from '../components/ArticleTree';
import { ArticlePanel } from '../components/ArticlePanel';
import { CreateDocDialog } from '../components/CreateDocDialog';
import { CreateDirDialog } from '../components/CreateDirDialog';
import { useKbTabs } from '../store/kbTabs';
import { qk } from '../../../shared/api/keys';
import { KbHomePage } from './KbHomePage';

/** 从 location 解析当前文章 tab（/kb 或 /kb/d/:id）——单路由 splat 形态，切换零重挂 */
function docIdOf(pathname: string): string | undefined {
  return /^\/kb\/d\/([^/]+)/.exec(pathname)?.[1];
}

export function KbShellPage() {
  const { token } = theme.useToken();
  const location = useLocation();
  const docId = docIdOf(location.pathname);
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

  /** 左树点击文章：开 tab + 路由跟随（useCallback 稳定引用——ArticleTree memo 生效前提） */
  const onOpenDoc = useCallback(
    (id: string, title: string) => {
      open(id, title);
      navigate(`/kb/d/${id}`);
    },
    [open, navigate],
  );

  return (
    <div data-testid="kb-shell" style={{ height: '100%', minHeight: 0, display: 'flex' }}>
      <aside
        style={{
          flex: 'none',
          width: 244,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <Flex align="center" justify="space-between" style={{ flex: 'none', padding: '10px 12px 6px' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            文章树
          </Typography.Text>
          <Space size={0}>
            <AntdButton type="text" size="small" icon={<FilePlus2 size={13} />} data-testid="kb-btn-create-doc" onClick={() => setDlg('doc')}>
              文章
            </AntdButton>
            <AntdButton type="text" size="small" icon={<FolderPlus size={13} />} data-testid="kb-btn-create-dir" onClick={() => setDlg('dir')}>
              目录
            </AntdButton>
          </Space>
        </Flex>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 6px 12px' }}>
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
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div data-testid="kb-tabs" style={{ flex: 'none' }}>
          <Tabs
            type="card"
            hideAdd
            size="small"
            activeKey={activeKey}
            onChange={goTab}
            onEdit={(key, action) => {
              if (action === 'remove') onCloseTab(String(key));
            }}
            items={tabs.map((t) => ({
              key: t.key,
              label:
                t.key === 'home' ? (
                  <span data-testid="kb-tab">
                    <Home size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
                    {t.title}
                  </span>
                ) : (
                  <span data-testid="kb-tab" title={t.title}>
                    {t.title}
                  </span>
                ),
              closable: t.key !== 'home',
            }))}
          />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* 首页 tab=原 KbHomePage 整页复用（概览卡/大搜索/榜单三列/最近查看） */}
          {activeKey === 'home' ? <KbHomePage /> : <ArticlePanel docId={activeKey} />}
        </div>
      </div>
    </div>
  );
}
