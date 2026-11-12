/**
 * 应用商店（D09 PEC-07 / E1）：应用 catalog 差异视图——可安装/可升级/已装/已撤销
 * 四态卡流；安装/升级/卸载即时生效；tools.reload 热加载随宿主命令阶段二（登记）。
 * 灰度（E2）与签名链（10 §7）接入后本页自动透出对应态。
 * 技能市场已并入插件页（D22 决策③：/agent/plugins 超集，SkillTab 删除）。
 */

import { useCallback, useEffect, useState } from 'react';
import { Ban, CheckCircle2, Download, Package, RotateCcw, Upload } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { Empty } from '../../../shared/ui/Empty';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { fetchCatalog, installApp, uninstallApp, type CatalogEntry } from '../api/apps';

const ACTION_META: Record<CatalogEntry['action'], { label: string; icon: typeof Download; tone: string }> = {
  install: { label: '可安装', icon: Download, tone: 'ok' },
  upgrade: { label: '可升级', icon: Upload, tone: 'warn' },
  noop: { label: '已安装', icon: CheckCircle2, tone: 'muted' },
  revoke: { label: '已下架', icon: Ban, tone: 'danger' },
};

export function AppStorePage() {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError('');
    fetchCatalog()
      .then(setEntries)
      .catch(() => {
        setEntries([]);
        setError('应用目录加载失败');
      });
  }, []);
  useEffect(reload, [reload]);

  const doInstall = (id: string) => {
    setBusyId(id);
    void installApp(id)
      .then(reload)
      .catch(() => setError('安装失败'))
      .finally(() => setBusyId(null));
  };

  const doUninstall = (id: string) => {
    if (!window.confirm('卸载后该应用的工具将从 Agent 注册表移除（进行中调用将失败）')) return;
    setBusyId(id);
    void uninstallApp(id)
      .then(reload)
      .catch(() => setError('卸载失败'))
      .finally(() => setBusyId(null));
  };

  return (
    <div className="eco-store" data-testid="eco-store">
      <header className="eco-store__head">
        <h2>
          <Package size={16} /> 应用
        </h2>
        <span className="eco-store__hint">管理员发布的应用与工具集；安装后 Agent 工具注册表同步（热加载随阶段二）</span>
      </header>
      {error ? <div className="eco-store__error">{error}</div> : null}
      {entries === null ? (
        <SkeletonList count={4} />
      ) : entries.length === 0 ? (
        <Empty text="暂无已发布应用（管理员可在管理端「应用」登记发布）" />
      ) : (
        <div className="eco-store__grid">
          {entries.map((e) => {
            const meta = ACTION_META[e.action];
            return (
              <div key={e.id} className={`eco-card eco-card--${meta.tone}`} data-testid="eco-app-card">
                <div className="eco-card__head">
                  <b>{e.name}</b>
                  <span className={`tag tag--${meta.tone === 'muted' ? 'builtin' : meta.tone === 'danger' ? 'danger' : 'ok'}`}>
                    {meta.label}
                  </span>
                </div>
                <div className="eco-card__meta">
                  {e.app_id} · v{e.current_version}
                  {e.installed_v && e.action === 'upgrade' ? `（本地 v${e.installed_v}）` : ''}
                </div>
                {e.description ? <p className="eco-card__desc">{e.description}</p> : null}
                <div className="eco-card__ops">
                  {e.action === 'install' || e.action === 'upgrade' ? (
                    <Button loading={busyId === e.id} onClick={() => doInstall(e.id)} data-testid={`eco-install-${e.id}`}>
                      {e.action === 'upgrade' ? <RotateCcw size={12} /> : <Download size={12} />}
                      {e.action === 'upgrade' ? '升级' : '安装'}
                    </Button>
                  ) : null}
                  {e.action === 'noop' || e.action === 'upgrade' ? (
                    <Button variant="secondary" disabled={busyId === e.id} onClick={() => doUninstall(e.id)}>
                      卸载
                    </Button>
                  ) : null}
                  {e.action === 'revoke' ? <span className="eco-card__revoke-note">应用已下架，本地副本失效</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
