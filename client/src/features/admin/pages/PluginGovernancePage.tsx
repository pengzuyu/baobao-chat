/**
 * 管理端·插件治理（D22 §3.2 管理面 / 方案 A 审核台）：
 * - 列表全量（公共 + 个人提交——owner 列透出）
 * - 上传公共插件（multipart zip + 三档策略；与插件页个人上传通道分离）
 * - 版本线展开 → 逐版本「发布进公共市场」（方案 A 审核动作：个人插件 draft
 *   经此进公共；owner 视角不变）
 * - 下架 / policy 调整（force=全员推发免确认、recommend 置顶、optional）
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import { Package, Plus, Puzzle, Upload } from 'lucide-react';
import { errText, http, postMultipart } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';

interface PluginRow {
  id: string;
  plugin_id: string;
  name: string;
  description: string;
  category: string;
  policy: number;
  status: string;
  current_version: string;
  owner_user_id?: number;
  manifest?: {
    components: { skills: number; mcpServers: number; commands: number; agents: number; hooks: boolean };
    usesIdentity?: boolean;
  };
}

interface VersionRow {
  id: string;
  version: string;
  notes?: string;
  created_at: number;
}

const POLICY_LABEL: Record<number, string> = { 1: '强制（force）', 2: '推荐（recommend）', 3: '可选（optional）' };

export function PluginGovernancePage() {
  const [plugins, setPlugins] = useState<PluginRow[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // 上传公共插件
  const [pubOpen, setPubOpen] = useState(false);
  const [pubFile, setPubFile] = useState<File | null>(null);
  const [pubNotes, setPubNotes] = useState('');
  const [pubPolicy, setPubPolicy] = useState(3);
  const [uploading, setUploading] = useState(false);
  // 版本线展开行
  const [verRow, setVerRow] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);

  const reload = useCallback(() => {
    setError('');
    http
      .get<{ items: PluginRow[] }>('/admin/eco/plugins')
      .then((d) => setPlugins(d.items ?? []))
      .catch((e) => {
        setPlugins([]);
        setError(errText(e, '加载失败'));
      });
  }, []);
  useEffect(reload, [reload]);

  const uploadPublic = () => {
    if (!pubFile) return;
    setUploading(true);
    const fd = new FormData();
    fd.append('package', pubFile);
    if (pubNotes.trim()) fd.append('notes', pubNotes.trim());
    fd.append('policy', String(pubPolicy));
    void postMultipart('/admin/eco/plugins', fd)
      .then(() => {
        setNotice(`已上传 ${pubFile.name}（draft——展开版本线点「发布」后进公共市场）`);
        setPubOpen(false);
        setPubFile(null);
        setPubNotes('');
        reload();
      })
      .catch((e) => setError(`上传失败：${errText(e, '未知错误')}`))
      .finally(() => setUploading(false));
  };

  const openVersions = (p: PluginRow) => {
    if (verRow === p.plugin_id) {
      setVerRow(null);
      return;
    }
    setVerRow(p.plugin_id);
    setVersions([]);
    http
      .get<{ items: VersionRow[] }>(`/admin/eco/plugins/${encodeURIComponent(p.plugin_id)}/versions`)
      .then((d) => setVersions(d.items ?? []))
      .catch((e) => setError(errText(e, '版本线加载失败')));
  };

  const publishVersion = (pluginId: string, version: string) => {
    if (!window.confirm(`发布 ${pluginId} v${version} 进公共市场？所有用户将可见可装`)) return;
    setBusy(true);
    void http
      .post(`/admin/eco/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}/publish`, {})
      .then(() => {
        setNotice(`${pluginId} v${version} 已发布进公共市场`);
        reload();
      })
      .catch((e) => setError(`发布失败：${errText(e, '未知错误')}`))
      .finally(() => setBusy(false));
  };

  const delist = (p: PluginRow) => {
    if (!window.confirm(`下架「${p.name}？已装用户本地副本失效（catalog 不再可见）`)) return;
    setBusy(true);
    void http
      .post(`/admin/eco/plugins/${encodeURIComponent(p.plugin_id)}/delist`, {})
      .then(() => {
        setNotice(`${p.name} 已下架`);
        reload();
      })
      .catch((e) => setError(`下架失败：${errText(e, '未知错误')}`))
      .finally(() => setBusy(false));
  };

  const setPolicy = (pluginId: string, policy: number) => {
    setBusy(true);
    void http
      .patch(`/admin/eco/plugins/${encodeURIComponent(pluginId)}`, { policy })
      .then(reload)
      .catch((e) => setError(`策略调整失败：${errText(e, '未知错误')}`))
      .finally(() => setBusy(false));
  };

  return (
    <div className="admin-page__section" data-testid="admin-plugins">
      <div className="admin-page__head">
        <h2>插件</h2>
        <Button onClick={() => setPubOpen((v) => !v)} data-testid="plugin-pub-btn">
          <Plus size={14} /> 上传公共插件
        </Button>
      </div>
      {error ? <div className="admin-page__error">{error}</div> : null}
      {notice ? <div className="bbw-plugin__notice">{notice}</div> : null}

      {pubOpen ? (
        <div className="eco-reg">
          <p className="admin-role__desc">公共插件（全员可见；policy=force 时用户端免确认自动推装）。个人插件请走插件页「上传插件」</p>
          <input type="file" accept=".zip" aria-label="选择插件 zip 包" onChange={(e) => setPubFile(e.target.files?.[0] ?? null)} />
          <div className="eco-reg__row">
            <input placeholder="备注（可选）" value={pubNotes} onChange={(e) => setPubNotes(e.target.value)} />
            <select value={pubPolicy} onChange={(e) => setPubPolicy(Number(e.target.value))} title="三档策略">
              <option value={1}>强制（force）</option>
              <option value={2}>推荐（recommend）</option>
              <option value={3}>可选（optional）</option>
            </select>
          </div>
          <Button loading={uploading} disabled={!pubFile} onClick={uploadPublic} data-testid="plugin-pub-submit">
            <Upload size={12} /> 上传（draft）
          </Button>
        </div>
      ) : null}

      {plugins === null ? (
        <div className="admin-page__empty">加载中…</div>
      ) : plugins.length === 0 ? (
        <div className="admin-page__empty">暂无插件（用户个人上传也会出现在这里待审核）</div>
      ) : (
        <table className="admin-table" data-testid="admin-plugins-table">
          <thead>
            <tr>
              <th>插件</th>
              <th>plugin_id</th>
              <th>来源</th>
              <th>组件</th>
              <th>策略</th>
              <th>状态</th>
              <th>版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {plugins.map((p) => (
              <Fragment key={p.id}>
                <tr>
                  <td>
                    <span className="admin-role__name">
                      <Puzzle size={13} /> {p.name}
                    </span>
                    {p.description ? <div className="admin-role__desc">{p.description}</div> : null}
                  </td>
                  <td>{p.plugin_id}</td>
                  <td>{p.owner_user_id ? <span className="tag tag--warn">个人（uid {p.owner_user_id}）</span> : <span className="tag tag--builtin">公共</span>}</td>
                  <td>
                    {p.manifest
                      ? `技能${p.manifest.components.skills}·工具${p.manifest.components.mcpServers}·命令${p.manifest.components.commands}·专家${p.manifest.components.agents}`
                      : '—'}
                    {p.manifest?.usesIdentity ? <div className="admin-role__desc">⚠ 使用用户身份</div> : null}
                  </td>
                  <td>
                    <select value={p.policy} disabled={busy || p.owner_user_id !== 0} onChange={(e) => setPolicy(p.plugin_id, Number(e.target.value))} title={p.owner_user_id !== 0 ? '个人插件恒 optional' : undefined}>
                      <option value={1}>{POLICY_LABEL[1]}</option>
                      <option value={2}>{POLICY_LABEL[2]}</option>
                      <option value={3}>{POLICY_LABEL[3]}</option>
                    </select>
                  </td>
                  <td>
                    <span className={`tag${p.status === 'published' ? ' tag--builtin' : p.status === 'delisted' ? ' tag--danger' : ''}`}>
                      {p.status === 'published' ? '已上架' : p.status === 'delisted' ? '已下架' : '草稿'}
                    </span>
                  </td>
                  <td>v{p.current_version || '—'}</td>
                  <td>
                    <button type="button" className="admin-link-btn" onClick={() => openVersions(p)} data-testid={`plugin-vers-${p.plugin_id}`}>
                      版本线
                    </button>
                    {p.status !== 'delisted' ? (
                      <button type="button" className="admin-link-btn admin-link-btn--danger" disabled={busy} onClick={() => delist(p)}>
                        下架
                      </button>
                    ) : null}
                  </td>
                </tr>
                {verRow === p.plugin_id ? (
                  <tr className="eco-versions-row">
                    <td colSpan={8}>
                      {versions.length === 0 ? (
                        <div className="admin-page__empty">无版本行（包体缺失？）</div>
                      ) : (
                        <div className="eco-versions">
                          {versions.map((v) => (
                            <div key={v.id} className="eco-versions__row">
                              <span>
                                v{v.version}
                                {v.version === p.current_version ? '（当前）' : ''}
                              </span>
                              <span className="admin-role__desc">{v.notes || '—'}</span>
                              {v.version !== p.current_version || p.status !== 'published' ? (
                                <Button disabled={busy} onClick={() => publishVersion(p.plugin_id, v.version)} data-testid={`plugin-pubver-${p.plugin_id}-${v.version}`}>
                                  <Package size={12} /> 发布进公共市场
                                </Button>
                              ) : null}
                            </div>
                          ))}
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
