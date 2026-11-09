/**
 * 管理端·应用管理（D09 PEC-01..03 务实版 / E1）：登记（app_id+首版 manifest）
 * + 版本线（追加/发布）+ 下架 + 灰度（E2/OQ-B13：canary % 确定性放量+白名单
 * 100% 豁免——Catalog 按灰度收敛、Install 服务端闸门）。C 档双人审批与签名链
 * 随 E3（发布=直发，admin:app:publish 路由承担）；回滚=发布旧版。
 */

import { useCallback, useEffect, useState } from 'react';
import { Fragment } from 'react';
import { Package, Plus, Upload } from 'lucide-react';
import { ApiError, getErrorText, http } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';

interface AdminApp {
  id: string;
  app_id: string;
  name: string;
  description: string;
  status: string;
  current_version: string;
  created_at: number;
}

interface AdminAppVersion {
  id: string;
  version: string;
  high_risk: boolean;
  status: string;
  created_at: number;
}

const BLANK_MANIFEST = '{\n  "tools": [\n    { "name": "demo.tool", "risk": "low" }\n  ]\n}';

export function EcoAppsPage() {
  const [apps, setApps] = useState<AdminApp[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 登记表单
  const [regOpen, setRegOpen] = useState(false);
  const [appID, setAppID] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [manifest, setManifest] = useState(BLANK_MANIFEST);
  // 展开应用版本线
  const [openApp, setOpenApp] = useState<string | null>(null);
  const [versions, setVersions] = useState<AdminAppVersion[] | null>(null);
  const [newVer, setNewVer] = useState('');
  // 灰度面板（E2/OQ-B13）
  const [rolloutFor, setRolloutFor] = useState<{ appId: string; versionId: string } | null>(null);
  const [canaryPct, setCanaryPct] = useState('100');
  const [whitelist, setWhitelist] = useState(''); // 逗号分隔 uid

  const openRollout = (appId: string, versionId: string) => {
    setRolloutFor({ appId, versionId });
    void http
      .get<{ canary_pct: number; whitelist: number[] }>(`/admin/eco/apps/${encodeURIComponent(appId)}/rollout`)
      .then((r) => {
        setCanaryPct(String(r.canary_pct ?? 100));
        setWhitelist((r.whitelist ?? []).join(','));
      })
      .catch(() => undefined);
  };

  const saveRollout = () => {
    if (!rolloutFor) return;
    const pct = Number(canaryPct);
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
      setError('canary 须为 0-100 整数');
      return;
    }
    const wl = whitelist.split(/[,\s，]+/).map((x) => x.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    setBusy(true);
    void http
      .put(`/admin/eco/apps/${encodeURIComponent(rolloutFor.appId)}/rollout`, {
        version_row_id: rolloutFor.versionId,
        canary_pct: pct,
        whitelist: wl,
      })
      .then(() => setRolloutFor(null))
      .catch((e) => setError(e instanceof ApiError ? getErrorText(e.code) : '灰度设置失败'))
      .finally(() => setBusy(false));
  };

  const reload = useCallback(() => {
    setError('');
    http
      .get<{ items: AdminApp[] }>('/admin/eco/apps')
      .then((d) => setApps(d.items ?? []))
      .catch((e) => {
        setApps([]);
        setError(e instanceof ApiError ? getErrorText(e.code) : '加载失败');
      });
  }, []);
  useEffect(reload, [reload]);

  const register = () => {
    setBusy(true);
    setError('');
    void http
      .post('/admin/eco/apps', { app_id: appID.trim(), name: name.trim(), description: desc.trim(), version: version.trim(), manifest })
      .then(() => {
        setRegOpen(false);
        setAppID('');
        setName('');
        setDesc('');
        setVersion('1.0.0');
        reload();
      })
      .catch((e) => setError(e instanceof ApiError ? getErrorText(e.code) : '登记失败'))
      .finally(() => setBusy(false));
  };

  const openVersions = (id: string) => {
    if (openApp === id) {
      setOpenApp(null);
      return;
    }
    setOpenApp(id);
    setVersions(null);
    setNewVer('');
    void http
      .get<{ items: AdminAppVersion[] }>(`/admin/eco/apps/${encodeURIComponent(id)}/versions`)
      .then((d) => setVersions(d.items ?? []))
      .catch(() => setVersions([]));
  };

  const addVersion = (id: string) => {
    if (!newVer.trim()) return;
    setBusy(true);
    void http
      .post(`/admin/eco/apps/${encodeURIComponent(id)}/versions`, { version: newVer.trim(), manifest })
      .then(() => {
        openVersions(id);
        reload();
      })
      .catch((e) => setError(e instanceof ApiError ? getErrorText(e.code) : '版本追加失败'))
      .finally(() => setBusy(false));
  };

  const publish = (id: string, vid: string) => {
    if (!window.confirm('发布该版本？发布后全员商店可见、安装用户收升级（v0.1 直发——C 档审批随 E2/E3）')) return;
    setBusy(true);
    void http
      .post(`/admin/eco/apps/${encodeURIComponent(id)}/versions/${encodeURIComponent(vid)}/publish`, {})
      .then(reload)
      .catch((e) => setError(e instanceof ApiError ? getErrorText(e.code) : '发布失败'))
      .finally(() => setBusy(false));
  };

  const delist = (id: string, appName: string) => {
    if (!window.confirm(`下架「${appName}」？已安装用户的应用即刻失效（app.revoked）`)) return;
    setBusy(true);
    void http
      .post(`/admin/eco/apps/${encodeURIComponent(id)}/delist`, {})
      .then(reload)
      .catch((e) => setError(e instanceof ApiError ? getErrorText(e.code) : '下架失败'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="admin-page__section" data-testid="admin-eco-apps">
      <div className="admin-page__head">
        <h2>应用管理</h2>
        <Button onClick={() => setRegOpen((v) => !v)} data-testid="eco-reg-btn">
          <Plus size={14} /> 登记应用
        </Button>
      </div>
      {error ? <div className="admin-page__error">{error}</div> : null}

      {regOpen ? (
        <div className="eco-reg">
          <div className="eco-reg__row">
            <input placeholder="app_id（如 crm.sync）" value={appID} onChange={(e) => setAppID(e.target.value)} data-testid="eco-reg-appid" />
            <input placeholder="显示名" value={name} onChange={(e) => setName(e.target.value)} />
            <input placeholder="首版版本（x.y.z）" value={version} onChange={(e) => setVersion(e.target.value)} />
          </div>
          <input className="eco-reg__desc" placeholder="描述（可选）" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <textarea
            placeholder="AppManifest JSON（工具/技能清单）"
            value={manifest}
            onChange={(e) => setManifest(e.target.value)}
            rows={6}
            data-testid="eco-reg-manifest"
          />
          <Button loading={busy} disabled={!appID.trim() || !name.trim()} onClick={register} data-testid="eco-reg-submit">
            登记并建首版（draft）
          </Button>
        </div>
      ) : null}

      {apps === null ? (
        <div className="admin-page__empty">加载中…</div>
      ) : apps.length === 0 ? (
        <div className="admin-page__empty">暂无应用——点「登记应用」发布第一个生态应用</div>
      ) : (
        <table className="admin-table" data-testid="eco-apps-table">
          <thead>
            <tr>
              <th>应用</th>
              <th>app_id</th>
              <th>状态</th>
              <th>当前版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((a) => (
              <Fragment key={a.id}>
                <tr>
                  <td>
                    <span className="admin-role__name">
                      <Package size={13} /> {a.name}
                    </span>
                    {a.description ? <div className="admin-role__desc">{a.description}</div> : null}
                  </td>
                  <td>{a.app_id}</td>
                  <td>
                    <span className={`tag${a.status === 'published' ? ' tag--builtin' : a.status === 'delisted' ? ' tag--danger' : ''}`}>
                      {a.status === 'published' ? '已发布' : a.status === 'delisted' ? '已下架' : '草稿'}
                    </span>
                  </td>
                  <td>{a.current_version || '—'}</td>
                  <td>
                    <button type="button" className="admin-link-btn" onClick={() => openVersions(a.id)} data-testid={`eco-versions-${a.id}`}>
                      版本
                    </button>
                    {a.status !== 'delisted' ? (
                      <button type="button" className="admin-link-btn admin-link-btn--danger" disabled={busy} onClick={() => delist(a.id, a.name)}>
                        下架
                      </button>
                    ) : null}
                  </td>
                </tr>
                {openApp === a.id ? (
                  <tr className="eco-versions-row">
                    <td colSpan={5}>
                      {versions === null ? (
                        <div className="admin-page__empty">版本线加载中…</div>
                      ) : (
                        <div className="eco-versions">
                          {versions.map((v) => (
                            <div key={v.id} className="eco-versions__row">
                              <span>v{v.version}</span>
                              <span className={`tag${v.status === 'published' ? ' tag--builtin' : ''}`}>
                                {v.status === 'published' ? '已发布' : v.status === 'rolled_back' ? '已回滚' : '草稿'}
                              </span>
                              {v.high_risk ? <span className="tag tag--danger">高危</span> : null}
                              {v.status !== 'published' ? (
                                <button type="button" className="admin-link-btn" disabled={busy} onClick={() => publish(a.id, v.id)} data-testid={`eco-publish-${v.id}`}>
                                  发布
                                </button>
                              ) : null}
                              <button type="button" className="admin-link-btn" disabled={busy} onClick={() => openRollout(a.id, v.id)} data-testid={`eco-rollout-${v.id}`}>
                                灰度
                              </button>
                            </div>
                          ))}
                          <div className="eco-versions__add">
                            <input placeholder="新版本号（x.y.z）" value={newVer} onChange={(e) => setNewVer(e.target.value)} data-testid="eco-newver" />
                            <Button loading={busy} disabled={!newVer.trim()} onClick={() => addVersion(a.id)}>
                              <Upload size={12} /> 追加版本（draft）
                            </Button>
                          </div>
                          {rolloutFor?.appId === a.id ? (
                            <div className="eco-rollout" data-testid="eco-rollout-panel">
                              <span className="eco-rollout__title">灰度（v 目标版本行 {rolloutFor.versionId}）</span>
                              <div className="eco-rollout__row">
                                <label>
                                  canary %
                                  <input value={canaryPct} onChange={(e) => setCanaryPct(e.target.value)} data-testid="eco-canary-input" />
                                </label>
                                <label className="eco-rollout__wl">
                                  白名单（逗号分隔 uid，100% 豁免）
                                  <input value={whitelist} onChange={(e) => setWhitelist(e.target.value)} placeholder="10001,10002" data-testid="eco-whitelist-input" />
                                </label>
                                <Button loading={busy} onClick={() => saveRollout()} data-testid="eco-rollout-save">
                                  应用
                                </Button>
                                <Button variant="secondary" onClick={() => setRolloutFor(null)}>
                                  取消
                                </Button>
                              </div>
                              <span className="eco-rollout__hint">确定性放量 uid%100&lt;pct；未入灰度未装=不可见，已装=保持当前版；100=全量</span>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
