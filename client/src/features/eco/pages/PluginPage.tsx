/**
 * 插件页（D22 §4 / 批次 L2）：市场（检索/筛选/安装/更新）+ 已安装（启禁/卸载）
 * + 详情抽屉（组件清单/权限声明/版本线/配置表单）。
 * 技能=单组件插件，本页为技能市场超集（SkillTab 已删并入；旧 /eco/skills 接口保留）。
 * 装配生效（skills 注入/MCP 工具面）随 L3——安装后提示重启会话兜底。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, CheckCircle2, Download, Package, Puzzle, RefreshCw, ShieldAlert, Sparkles, Terminal, Trash2, Wrench,
} from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { Empty } from '../../../shared/ui/Empty';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import {
  fetchLocalState, fetchMyPlugins, fetchPluginCatalog, fetchPluginDetail,
  installPlugin, setPluginEnabled, uninstallPlugin, writePluginConfig,
  type CatalogQuery, type PluginEntry, type PluginLocalState, type PluginVersion,
} from '../api/plugins';

const CATEGORIES = ['', 'devops', 'kb', 'im', 'office', 'other'];
const COMPONENTS: { value: NonNullable<CatalogQuery['component']>; label: string }[] = [
  { value: '', label: '全部组件' },
  { value: 'tool', label: '带工具' },
  { value: 'skill', label: '带技能' },
  { value: 'command', label: '带命令' },
  { value: 'agent', label: '带专家' },
];

const POLICY_META: Record<number, { label: string; tone: string }> = {
  1: { label: '企业已推', tone: 'ok' },
  2: { label: '推荐', tone: 'warn' },
  3: { label: '', tone: '' },
};

function componentBadges(e: PluginEntry): { label: string; icon: typeof Wrench }[] {
  const out: { label: string; icon: typeof Wrench }[] = [];
  const c = e.manifest?.components;
  if (!c) return out;
  if (c.mcpServers > 0) out.push({ label: `工具×${c.mcpServers}`, icon: Wrench });
  if (c.skills > 0) out.push({ label: `技能×${c.skills}`, icon: Sparkles });
  if (c.commands > 0) out.push({ label: `命令×${c.commands}`, icon: Terminal });
  if (c.agents > 0) out.push({ label: `专家×${c.agents}`, icon: Bot });
  if (c.hooks) out.push({ label: 'hooks', icon: Puzzle });
  return out;
}

export function PluginPage() {
  const [tab, setTab] = useState<'market' | 'installed'>('market');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [component, setComponent] = useState<NonNullable<CatalogQuery['component']>>('');
  const [entries, setEntries] = useState<PluginEntry[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  // 详情抽屉
  const [detail, setDetail] = useState<{ plugin: PluginEntry; versions: PluginVersion[] } | null>(null);
  const [local, setLocal] = useState<PluginLocalState | null>(null);
  // 配置表单
  const [configDraft, setConfigDraft] = useState<Record<string, string>>({});
  const searchTimer = useRef<number | null>(null);

  const reload = useCallback(() => {
    setError('');
    setNotice('');
    const query: CatalogQuery = {};
    if (q.trim()) query.q = q.trim();
    if (category) query.category = category;
    if (component) query.component = component;
    const fetcher = tab === 'installed' ? fetchMyPlugins() : fetchPluginCatalog(query);
    fetcher
      .then(setEntries)
      .catch((e) => {
        setEntries([]);
        setError(`插件目录加载失败（${e instanceof Error ? e.message : '网络错误'}）`);
      });
  }, [q, category, component, tab]);
  useEffect(reload, [reload]);

  // 详情打开时拉本地态（启禁开关对照 + 配置草稿回填）
  useEffect(() => {
    if (!detail) return;
    fetchLocalState(detail.plugin.plugin_id)
      .then((s) => {
        setLocal(s);
        if (detail.plugin.manifest?.configKeys?.length) {
          setConfigDraft(s?.config ?? {});
        }
      })
      .catch(() => setLocal(null));
  }, [detail]);

  const doInstall = (e: PluginEntry) => {
    // 权限确认（D22 §6.3：身份使用显著提示；force 免确认由服务端策略面控制，此处统一提示）
    const usesIdentity = e.manifest?.usesIdentity;
    const net = e.manifest?.netAllow?.length ? `将访问：${e.manifest.netAllow.join('、')}` : '';
    if (usesIdentity || net) {
      const idMsg = usesIdentity ? '\n⚠️ 该插件将以你的身份调用系统（自动注入登录凭证）' : '';
      if (!window.confirm(`安装 ${e.name}？${idMsg}\n${net}`)) return;
    }
    setBusyId(e.plugin_id);
    setNotice('');
    void installPlugin(e.plugin_id, e.installed && e.has_update ? e.current_version : undefined)
      .then(() => {
        setNotice(`${e.name} 已安装（即时生效——工具与技能已装配，进行中会话下轮生效）`);
        reload();
      })
      .catch((err) => setError(`安装失败：${err instanceof Error ? err.message : '未知错误'}`))
      .finally(() => setBusyId(null));
  };

  const doUninstall = (e: PluginEntry) => {
    if (!window.confirm(`卸载 ${e.name}？本地文件与配置（默认保留）将移除，能力即时失效`)) return;
    setBusyId(e.plugin_id);
    void uninstallPlugin(e.plugin_id, true)
      .then(() => {
        setNotice(`${e.name} 已卸载`);
        reload();
      })
      .catch((err) => setError(`卸载失败：${err instanceof Error ? err.message : '未知错误'}`))
      .finally(() => setBusyId(null));
  };

  const doToggle = (e: PluginEntry, enabled: boolean) => {
    setBusyId(e.plugin_id);
    void setPluginEnabled(e.plugin_id, enabled)
      .then(() => {
        setLocal((prev) => (prev ? { ...prev, enabled } : prev));
        setNotice(`${e.name} 已${enabled ? '启用' : '禁用'}（即时生效）`);
      })
      .catch((err) => setError(`操作失败：${err instanceof Error ? err.message : '未知错误'}`))
      .finally(() => setBusyId(null));
  };

  const openDetail = (e: PluginEntry) => {
    setDetail(null);
    setConfigDraft({});
    void fetchPluginDetail(e.plugin_id)
      .then(setDetail)
      .catch((err) => setError(`详情加载失败：${err instanceof Error ? err.message : '未知错误'}`));
  };

  const saveConfig = (pluginId: string) => {
    setBusyId(pluginId);
    void writePluginConfig(pluginId, configDraft)
      .then(() => setNotice('配置已保存'))
      .catch((err) => setError(`保存失败：${err instanceof Error ? err.message : '未知错误'}`))
      .finally(() => setBusyId(null));
  };

  const handleSearch = (value: string) => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => setQ(value), 300);
  };

  const shown = useMemo(() => entries ?? null, [entries]);

  return (
    <div className="eco-store bbw-plugin" data-testid="bbw-plugin">
      <header className="eco-store__head">
        <h2>
          <Puzzle size={16} /> 插件
        </h2>
        <span className="eco-store__hint">安装即得 Agent 新能力：技能 / 工具 / 命令 / 专家一包携带（生效随新会话）</span>
      </header>

      <div className="admin-tabs" role="tablist" style={{ paddingBottom: 8 }}>
        <button type="button" role="tab" aria-selected={tab === 'market'} className={`admin-tab${tab === 'market' ? ' admin-tab--active' : ''}`} onClick={() => setTab('market')}>
          <Package size={14} /> 市场
        </button>
        <button type="button" role="tab" aria-selected={tab === 'installed'} className={`admin-tab${tab === 'installed' ? ' admin-tab--active' : ''}`} onClick={() => setTab('installed')}>
          <CheckCircle2 size={14} /> 已安装{entries?.length !== undefined && tab === 'installed' ? `（${entries.length}）` : ''}
        </button>
      </div>

      {tab === 'market' ? (
        <div className="bbw-plugin__filters">
          <input
            className="bbw-plugin__search"
            type="search"
            placeholder="搜索名称 / 描述（支持拼音待接入）"
            onChange={(e) => handleSearch(e.target.value)}
            aria-label="搜索插件"
          />
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="分类">
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c === '' ? '全部分类' : c}</option>
            ))}
          </select>
          <select value={component} onChange={(e) => setComponent(e.target.value as NonNullable<CatalogQuery['component']>)} aria-label="组件类型">
            {COMPONENTS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
      ) : null}

      {error ? <div className="eco-store__error">{error}</div> : null}
      {notice ? <div className="bbw-plugin__notice">{notice}</div> : null}

      {shown === null ? (
        <SkeletonList count={4} />
      ) : shown.length === 0 ? (
        <Empty text={tab === 'market' ? '暂无匹配插件（管理员可在管理端发布插件包）' : '尚未安装任何插件'} />
      ) : (
        <div className="eco-store__grid">
          {shown.map((e) => {
            const badges = componentBadges(e);
            const policy = POLICY_META[e.policy];
            return (
              <div key={e.plugin_id} className="eco-card bbw-plugin__card" data-testid={`bbw-plugin-card-${e.plugin_id}`}>
                <div className="eco-card__head">
                  <b className="bbw-plugin__name" onClick={() => openDetail(e)} role="button" tabIndex={0} onKeyDown={(ev) => ev.key === 'Enter' && openDetail(e)}>
                    {e.name}
                  </b>
                  {policy?.label ? <span className={`tag tag--${policy.tone}`}>{policy.label}</span> : null}
                  {e.manifest?.usesIdentity ? <span className="tag tag--warn" title="将以你的身份调用系统"><ShieldAlert size={11} /> 身份</span> : null}
                </div>
                <div className="eco-card__meta">
                  {e.plugin_id} · v{e.current_version}
                  {e.installed && e.version ? `（本地 v${e.version}）` : ''}
                </div>
                {e.description ? <p className="eco-card__desc">{e.description}</p> : null}
                {badges.length ? (
                  <div className="bbw-plugin__badges">
                    {badges.map((b) => (
                      <span key={b.label} className="bbw-plugin__badge"><b.icon size={11} aria-hidden />{b.label}</span>
                    ))}
                  </div>
                ) : null}
                <div className="eco-card__ops">
                  {!e.installed || e.has_update ? (
                    <Button loading={busyId === e.plugin_id} onClick={() => doInstall(e)} data-testid={`bbw-plugin-install-${e.plugin_id}`}>
                      {e.has_update ? <RefreshCw size={12} /> : <Download size={12} />}
                      {e.has_update ? '更新' : '安装'}
                    </Button>
                  ) : null}
                  {e.installed ? (
                    <Button variant="secondary" disabled={busyId === e.plugin_id} onClick={() => doUninstall(e)}>
                      <Trash2 size={12} /> 卸载
                    </Button>
                  ) : null}
                  <Button variant="secondary" onClick={() => openDetail(e)}>详情</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {detail ? (
        <div className="bbw-plugin__drawer" role="dialog" aria-label={`${detail.plugin.name} 详情`}>
          <div className="bbw-plugin__drawer-mask" onClick={() => setDetail(null)} />
          <div className="bbw-plugin__drawer-body">
            <header className="bbw-plugin__drawer-head">
              <h3>{detail.plugin.name} <small>{detail.plugin.plugin_id}</small></h3>
              <button type="button" className="bbw-plugin__drawer-close" onClick={() => setDetail(null)} aria-label="关闭">×</button>
            </header>
            <p className="bbw-plugin__drawer-desc">{detail.plugin.manifest?.description || detail.plugin.description}</p>

            {detail.plugin.installed && local ? (
              <section className="bbw-plugin__section">
                <h4>本地状态</h4>
                <label className="bbw-plugin__switch">
                  <input
                    type="checkbox"
                    checked={local.enabled}
                    disabled={busyId === detail.plugin.plugin_id}
                    onChange={(ev) => doToggle(detail.plugin, ev.target.checked)}
                  />
                  {local.enabled ? '已启用' : '已禁用'}（v{local.activeVersion}{local.versions.length > 1 ? `，共 ${local.versions.length} 版` : ''}）
                </label>
              </section>
            ) : null}

            <section className="bbw-plugin__section">
              <h4>组件</h4>
              {(() => {
                const badges = componentBadges(detail.plugin);
                return badges.length ? (
                  <div className="bbw-plugin__badges">
                    {badges.map((b) => <span key={b.label} className="bbw-plugin__badge"><b.icon size={11} aria-hidden />{b.label}</span>)}
                  </div>
                ) : <span className="bbw-plugin__muted">无（信息缺失）</span>;
              })()}
            </section>

            <section className="bbw-plugin__section">
              <h4>权限声明</h4>
              <ul className="bbw-plugin__perm">
                <li>风险级：{detail.plugin.manifest?.risk ?? 'medium'}</li>
                {detail.plugin.manifest?.usesIdentity ? (
                  <li className="bbw-plugin__perm-warn"><ShieldAlert size={12} /> 将以你的身份调用系统（自动注入登录凭证）</li>
                ) : null}
                {detail.plugin.manifest?.netAllow?.length ? (
                  <li>网络访问：{detail.plugin.manifest.netAllow.join('、')}（v0.1 声明展示，强制执行阶段二）</li>
                ) : null}
                {detail.plugin.manifest?.configKeys?.length ? (
                  <li>需要配置：{detail.plugin.manifest.configKeys.join('、')}</li>
                ) : null}
                <li>全部工具调用与内置工具同一审批门控（无特权）</li>
              </ul>
            </section>

            {detail.plugin.manifest?.configKeys?.length ? (
              <section className="bbw-plugin__section">
                <h4>配置</h4>
                {detail.plugin.manifest.configKeys.map((key) => (
                  <label key={key} className="bbw-plugin__config-row">
                    <span>{key}</span>
                    <input
                      type="password"
                      value={configDraft[key] ?? ''}
                      placeholder={/token|secret|key/i.test(key) ? '敏感值（加密存储随 L4 接入，当前暂存本地）' : ''}
                      onChange={(ev) => setConfigDraft((prev) => ({ ...prev, [key]: ev.target.value }))}
                    />
                  </label>
                ))}
                <Button disabled={busyId === detail.plugin.plugin_id} onClick={() => saveConfig(detail.plugin.plugin_id)}>保存配置</Button>
              </section>
            ) : null}

            <section className="bbw-plugin__section">
              <h4>版本</h4>
              <ul className="bbw-plugin__versions">
                {detail.versions.map((v) => (
                  <li key={v.id}>
                    v{v.version}{v.version === detail.plugin.current_version ? '（当前）' : ''}
                    {v.notes ? ` — ${v.notes}` : ''}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
}
