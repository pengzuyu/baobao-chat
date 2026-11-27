/**
 * 插件页（D22 §4 / 批次 L2）：市场（检索/筛选/安装/更新）+ 已安装（启禁/卸载）
 * + 详情抽屉（组件清单/权限声明/版本线/配置表单）。
 * 技能=单组件插件，本页为技能市场超集（SkillTab 已删并入；旧 /eco/skills 接口保留）。
 * 装配生效（skills 注入/MCP 工具面）随 L3——安装后提示重启会话兜底。
 * D26-O3：eco- / bbc-plugin- 前缀自研结构退役——tabs→Tabs、卡片→Card、上传→Upload
 * （beforeUpload return false + 受控 fileList）、plugin-drawer→Drawer、
 * window.confirm×2→Modal.confirm（危险卸载 danger 红钮）。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert, Card, Drawer, Flex, Form, Input, List, Modal, message, Select, Space, Switch, Tabs, Tag, Typography, Upload,
} from 'antd';
import type { UploadFile } from 'antd';
import {
  Bot, CheckCircle2, Download, KeyRound, Package, Puzzle, RefreshCw, Search, ShieldAlert, Sparkles, Terminal, Trash2, Upload as UploadIcon, Wrench,
} from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { Empty } from '../../../shared/ui/Empty';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { MarkdownText } from '../../../shared/components/MarkdownText';
import {
  fetchLocalPlugins, fetchLocalState, fetchMyPlugins, fetchPluginCatalog, fetchPluginDetail,
  installPlugin, isTauriAvailable, localToEntry, setPluginEnabled, setPluginUseIdentity, uninstallPlugin,
  uploadMyPlugin, writePluginConfig,
  type CatalogQuery, type LocalPlugin, type PluginEntry, type PluginLocalState, type PluginVersion,
} from '../api/plugins';
import { AgentSubNav } from '../../agent/components/AgentSubNav';
import { pathsToFiles } from '../../../shared/attachments';
import { useFileDrop } from '../../../shared/attachments/hooks';

/** 桌面端才有本机安装目录；web 预览不做对账（否则已装的全被误标本机未装） */
const DESKTOP = isTauriAvailable();

const CATEGORIES = ['', 'devops', 'kb', 'im', 'office', 'other'];
/** 平台凭证占位（RT 调用层按受众票逐请求动态注入——D38 单票制）；敏感项快捷填充写此值 */
const PLATFORM_TOKEN = '${BBC_USER_TOKEN}';
/** 认证语义 key 命中（与占位提示同口径）——快捷填充按钮的展示条件之一 */
const AUTH_KEY_RE = /token|secret|key|auth|credential/i;
const COMPONENTS: { value: NonNullable<CatalogQuery['component']>; label: string }[] = [
  { value: '', label: '全部组件' },
  { value: 'tool', label: '带工具' },
  { value: 'skill', label: '带技能' },
  { value: 'command', label: '带命令' },
  { value: 'agent', label: '带专家' },
];

const POLICY_META: Record<number, { label: string; color: string }> = {
  1: { label: '企业已推', color: 'green' },
  2: { label: '推荐', color: 'gold' },
  3: { label: '', color: '' },
};

/** D39：最近更新（YYYY-MM-DD，本地时区） */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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

function BadgeTags({ e }: { e: PluginEntry }) {
  const badges = componentBadges(e);
  if (badges.length === 0) return null;
  return (
    <Space size={4} wrap style={{ marginTop: 4 }}>
      {badges.map((b) => (
        <Tag key={b.label} icon={<b.icon size={11} aria-hidden />}>
          {b.label}
        </Tag>
      ))}
    </Space>
  );
}

export function PluginPage() {
  const [tab, setTab] = useState<'market' | 'installed'>('market');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [component, setComponent] = useState<NonNullable<CatalogQuery['component']>>('');
  const [entries, setEntries] = useState<PluginEntry[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  // 个人上传（方案 A）：选 zip + 备注 → POST multipart → 刷新列表
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadNotes, setUploadNotes] = useState('');
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState('');
  // 桌面端整窗拖拽（上传弹窗打开期间生效；HTML5 onDrop 在 Tauri 下不触发，
  // 原生拖拽只给路径，经 pathsToFiles 读回 File 走与点击相同的分支）
  const dragOver = useFileDrop(uploadOpen, (paths) => {
    void pathsToFiles(paths)
      .then((files) => {
        const zip = files.find((f) => /\.zip$/i.test(f.name));
        if (zip) setUploadFile(zip);
        else void message.warning('插件包须为 .zip 文件');
      })
      .catch((e) => void message.error(e instanceof Error ? e.message : String(e)));
  });
  // 详情抽屉
  const [detail, setDetail] = useState<{ plugin: PluginEntry; versions: PluginVersion[] } | null>(null);
  const [local, setLocal] = useState<PluginLocalState | null>(null);
  // 本机安装目录全量（对账用；local 是抽屉当前这一个）
  const [localPlugins, setLocalPlugins] = useState<LocalPlugin[]>([]);
  // 服务端安装记录是否加载成功（失败时无从判断某条是否「仅本机」，不贴标签）
  const [serverOk, setServerOk] = useState(true);
  // 配置表单
  const [configDraft, setConfigDraft] = useState<Record<string, string>>({});
  const searchTimer = useRef<number | null>(null);

  // keepMsg：调用方刚 setNotice 的场景（上传成功）跳过清空——reload 同步
  // setNotice('') 会在渲染前把提示吃掉（2026-11-25 真机反馈修复）
  const reload = useCallback((opts?: { keepMsg?: boolean }) => {
    setError('');
    if (!opts?.keepMsg) setNotice('');
    const query: CatalogQuery = {};
    if (q.trim()) query.q = q.trim();
    if (category) query.category = category;
    if (component) query.component = component;
    const fetcher = tab === 'installed' ? fetchMyPlugins() : fetchPluginCatalog(query);
    fetcher
      .then((list) => {
        setServerOk(true);
        setEntries(list);
      })
      .catch((e) => {
        setServerOk(false);
        setEntries([]);
        setError(`插件目录加载失败（${e instanceof Error ? e.message : '网络错误'}）`);
      });
    // 本机安装目录独立拉取（对账用）：自降级空不拒——服务端列表失败时本机
    // 已装的仍可见可管，错误语义照旧由上面的主列表决定
    void fetchLocalPlugins().then(setLocalPlugins);
  }, [q, category, component, tab]);
  useEffect(reload, [reload]);

  // 详情打开时拉本地态（启禁开关对照 + 配置草稿回填）
  useEffect(() => {
    if (!detail) return;
    fetchLocalState(detail.plugin.plugin_id)
      .then((s) => {
        setLocal(s);
        // 无条件回填：自动发现的 ${CONFIG:key}（清单未声明 configKeys）同样要回显
        setConfigDraft(s?.config ?? {});
      })
      .catch(() => setLocal(null));
  }, [detail]);

  // 本机对账：服务端安装记录与本机安装目录各是一份真相——Agent 装配只认本机
  // （壳 assemble_mcp_servers），服务端记录经数据重置/换账号可能缺失
  const localById = useMemo(
    () => new Map(localPlugins.map((p) => [p.pluginId, p] as const)),
    [localPlugins],
  );
  const serverIds = useMemo(() => new Set(entries?.map((e) => e.plugin_id)), [entries]);
  /** 服务端安装记录里查无此条：详情/卸载只走本机（无详情口；卸载接口回「插件不存在」） */
  const serverKnown = (pluginId: string) => serverIds.has(pluginId);
  /** 「仅本机」标签：已安装页、服务端记录加载成功却查无此条（对 Agent 生效，但此前页面不可见） */
  const isLocalOnly = (pluginId: string) => tab === 'installed' && serverOk && !serverKnown(pluginId);
  // 已安装页=服务端记录 ∪ 本机目录：「仅本机」补卡片（可见、可禁用、可卸载）
  const shown = useMemo(() => {
    if (!entries) return null;
    if (tab !== 'installed') return entries;
    const known = new Set(entries.map((e) => e.plugin_id));
    return [...entries, ...localPlugins.filter((p) => !known.has(p.pluginId)).map(localToEntry)];
  }, [entries, localPlugins, tab]);
  // 抽屉当前插件在本机确有安装（activeVersion 空=卸载保留配置的骨架目录）
  const localInstalled = !!local?.activeVersion;

  const doInstall = (e: PluginEntry) => {
    // 权限确认（D22 §6.3：身份使用显著提示；force 免确认由服务端策略面控制，此处统一提示）
    const usesIdentity = e.manifest?.usesIdentity;
    // D38：统一身份明示目的地（受众=生态应用端点）——「将以你的身份访问 X」
    const audiences = e.manifest?.authAudiences ?? [];
    const net = e.manifest?.netAllow?.length ? `将访问：${e.manifest.netAllow.join('、')}` : '';
    const proceed = () => {
      setBusyId(e.plugin_id);
      setNotice('');
      return installPlugin(e.plugin_id, e.installed && e.has_update ? e.current_version : undefined)
        .then(() => {
          setNotice(`${e.name} 已安装（即时生效——工具与技能已装配，进行中会话下轮生效）`);
          reload();
        })
        .catch((err) => setError(`安装失败：${err instanceof Error ? err.message : '未知错误'}`))
        .finally(() => setBusyId(null));
    };
    if (usesIdentity || net) {
      Modal.confirm({
        title: `安装 ${e.name}？`,
        content: (
          <div>
            {usesIdentity ? (
              <div>
                ⚠️ 该插件将以你的身份调用系统（自动注入登录凭证）
                {audiences.length ? <div style={{ marginTop: 4 }}>目的地：{audiences.join('、')}</div> : null}
              </div>
            ) : null}
            {net ? <div>{net}</div> : null}
          </div>
        ),
        okText: '安装',
        cancelText: '取消',
        onOk: proceed,
      });
      return;
    }
    void proceed();
  };

  const doUpload = () => {
    if (!uploadFile) return;
    setUploading(true);
    void uploadMyPlugin(uploadFile, uploadNotes.trim())
      .then((dto) => {
        setNotice(`已上传 ${dto.plugin_id}（个人区仅自己可见可装；进公共市场需管理员审核发布）`);
        setUploadOpen(false);
        setUploadFile(null);
        setUploadNotes('');
        reload({ keepMsg: true });
      })
      .catch((err) => setError(`上传失败：${err instanceof Error ? err.message : '未知错误'}`))
      .finally(() => setUploading(false));
  };

  const doUninstall = (e: PluginEntry) => {
    Modal.confirm({
      title: `卸载 ${e.name}？`,
      content: '本地文件与配置（默认保留）将移除，能力即时失效',
      okText: '卸载',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () =>
        uninstallPlugin(e.plugin_id, true, serverKnown(e.plugin_id))
          .then(() => {
            setNotice(`${e.name} 已卸载`);
            reload();
          })
          .catch((err) => setError(`卸载失败：${err instanceof Error ? err.message : '未知错误'}`)),
    });
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
    // 服务端无记录也就无详情口——本机清单 + 版本目录即详情
    const lp = localById.get(e.plugin_id);
    if (lp && !serverKnown(e.plugin_id)) {
      setDetail({
        plugin: e,
        versions: lp.versions.map((version) => ({ id: version, version, created_at: 0 })),
      });
      return;
    }
    void fetchPluginDetail(e.plugin_id)
      .then(setDetail)
      .catch((err) => setError(`详情加载失败：${err instanceof Error ? err.message : '未知错误'}`));
  };

  const saveConfig = (pluginId: string) => {
    setBusyId(pluginId);
    void writePluginConfig(pluginId, configDraft, configSecretKeys)
      .then(() => setNotice('配置已保存（工具面即时刷新）'))
      .catch((err) => setError(`保存失败：${err instanceof Error ? err.message : '未知错误'}`))
      .finally(() => setBusyId(null));
  };

  const handleSearch = (value: string) => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => setQ(value), 300);
  };

  // 配置表单 keys（2026-11-25 拍板自动发现）：清单声明 configKeys ∪ mcp 定义
  // 实际引用的 ${CONFIG:key}；secret = 清单 configSecrets ∪ headers 引用发现
  const configFormKeys = useMemo(() => {
    const declared = detail?.plugin.manifest?.configKeys ?? [];
    const declaredSecrets = detail?.plugin.manifest?.configSecrets ?? [];
    const out: { key: string; secret: boolean }[] = declared.map((key) => ({
      key,
      secret: declaredSecrets.includes(key),
    }));
    for (const d of local?.discoveredConfigKeys ?? []) {
      if (!declared.includes(d.key)) out.push(d);
    }
    return out;
  }, [detail, local]);

  const configSecretKeys = useMemo(
    () => configFormKeys.filter((k) => k.secret).map((k) => k.key),
    [configFormKeys],
  );

  // HTTP server 目的地（身份开关可见性判定 + 确认弹窗展示）
  const identityTargets = useMemo(
    () => (local?.mcpServers ?? []).filter((sv) => sv.kind === 'http').map((sv) => sv.url ?? ''),
    [local],
  );

  // 平台凭证快捷填充（2026-11-26）：仅插件含 HTTP MCP server 时可见
  // （stdio 无令牌拍板不变——占位在 env/args 一律剥空）
  const hasHttpServer = useMemo(
    () => (local?.mcpServers ?? []).some((sv) => sv.kind === 'http'),
    [local],
  );
  // 身份注入是否已定（无需用户开关）：作者声明 usesIdentity 恒注入，
  // 或任一 HTTP server 自带声明（x-bbc-auth/headers 占位——装配归一即注入）
  const identityDeclared = useMemo(
    () =>
      !!detail?.plugin.manifest?.usesIdentity ||
      (local?.mcpServers ?? []).some((sv) => sv.kind === 'http' && sv.authDeclared),
    [detail, local],
  );
  // 填了平台凭证但身份未注入 → 提示条 + 一键开启（不静默代开，D22 §6.3 授权须确认）
  const needIdentityHint = useMemo(
    () =>
      hasHttpServer &&
      !identityDeclared &&
      !local?.useIdentity &&
      Object.values(configDraft).some((v) => typeof v === 'string' && v.includes(PLATFORM_TOKEN)),
    [hasHttpServer, identityDeclared, local, configDraft],
  );

  const toggleIdentity = (pluginId: string, enabled: boolean) => {
    if (!enabled) {
      // 关闭=撤回身份（插件恢复匿名调用；作者声明的除外——见抽屉只读态）
      setBusyId(pluginId);
      void setPluginUseIdentity(pluginId, false)
        .then(() => {
          setLocal((prev) => (prev ? { ...prev, useIdentity: false } : prev));
          setNotice('已关闭「以我的身份调用」');
        })
        .catch((err) => setError(`操作失败：${err instanceof Error ? err.message : '未知错误'}`))
        .finally(() => setBusyId(null));
      return;
    }
    // 开启=授权：身份确认弹窗（同安装确认口径——D22 §6.3 / D38 目的地明示）
    Modal.confirm({
      title: '以你的身份调用？',
      content: (
        <div>
          <div>⚠️ 该插件的 HTTP MCP 将以你的身份调用系统（自动注入登录凭证，签发全量权限票据）</div>
          {identityTargets.length ? (
            <div style={{ marginTop: 4 }}>目的地：{identityTargets.join('、')}</div>
          ) : null}
          <div style={{ marginTop: 4 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              随时可在此关闭；禁用/卸载插件即停止注入
            </Typography.Text>
          </div>
        </div>
      ),
      okText: '开启',
      cancelText: '取消',
      onOk: () => {
        setBusyId(pluginId);
        return setPluginUseIdentity(pluginId, true)
          .then(() => {
            setLocal((prev) => (prev ? { ...prev, useIdentity: true } : prev));
            setNotice('已开启「以我的身份调用」（即时生效）');
          })
          .catch((err) => setError(`操作失败：${err instanceof Error ? err.message : '未知错误'}`))
          .finally(() => setBusyId(null));
      },
    });
  };

  return (
    /* Agent 域三页签常驻（2026-11-25 真机反馈：插件页此前无 SubNav 回不去工作台）；
       页内自滚动（2026-11-23 真机）：外壳不再滚动，内容在自己的容器里滚 */
    <div
      data-testid="bbc-plugin"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}
    >
      <AgentSubNav />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px' }}>
      <Flex align="center" gap={8} style={{ marginBottom: 8 }} wrap>
        <Puzzle size={16} />
        <Typography.Title level={5} style={{ margin: 0 }}>
          插件
        </Typography.Title>
        <Typography.Text type="secondary">
          安装即得 Agent 新能力：工具 / 命令 / 专家即时生效，技能随新会话
        </Typography.Text>
      </Flex>

      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as 'market' | 'installed')}
        items={[
          {
            key: 'market',
            label: (
              <Space size={4}>
                <Package size={14} /> 市场
              </Space>
            ),
          },
          {
            key: 'installed',
            label: (
              <Space size={4}>
                <CheckCircle2 size={14} /> 已安装
                {tab === 'installed' && shown ? `（${shown.length}）` : ''}
              </Space>
            ),
          },
        ]}
      />

      {tab === 'market' ? (
        <Flex gap={8} wrap style={{ marginBottom: 12 }}>
          <Input
            allowClear
            prefix={<Search size={14} />}
            placeholder="搜索名称 / 描述（支持拼音待接入）"
            onChange={(e) => handleSearch(e.target.value)}
            aria-label="搜索插件"
            style={{ width: 220 }}
          />
          <Select
            style={{ width: 130 }}
            value={category}
            onChange={setCategory}
            aria-label="分类"
            options={CATEGORIES.map((c) => ({ value: c, label: c === '' ? '全部分类' : c }))}
          />
          <Select<NonNullable<CatalogQuery['component']>>
            style={{ width: 130 }}
            value={component}
            onChange={(v) => setComponent(v)}
            aria-label="组件类型"
            options={COMPONENTS.map((c) => ({ value: c.value, label: c.label }))}
          />
          <Button variant="secondary" onClick={() => setUploadOpen(true)} data-testid="bbc-plugin-upload">
            <UploadIcon size={12} /> 上传插件
          </Button>
        </Flex>
      ) : null}

      <Modal
        open={uploadOpen}
        onCancel={() => !uploading && setUploadOpen(false)}
        title="上传个人插件（zip ≤10MB）"
        footer={
          <Space size={8}>
            <Button variant="secondary" disabled={uploading} onClick={() => setUploadOpen(false)}>
              取消
            </Button>
            <Button disabled={!uploadFile || uploading} loading={uploading} onClick={doUpload}>
              <UploadIcon size={12} /> 上传
            </Button>
          </Space>
        }
        width={480}
        destroyOnClose
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            上传后进入个人区：仅自己可见可装；进公共市场需管理员审核发布（支持整窗拖入 .zip）
          </Typography.Text>
          {dragOver ? <Typography.Text type="warning" style={{ fontSize: 12 }}>松开鼠标，自动填入 .zip 包</Typography.Text> : null}
          <Space size={8} wrap>
            <Upload
              accept=".zip"
              maxCount={1}
              beforeUpload={(file) => {
                setUploadFile(file);
                return false;
              }}
              onRemove={() => setUploadFile(null)}
              fileList={uploadFile ? ([{ uid: '-1', name: uploadFile.name, status: 'done' }] as UploadFile[]) : []}
            >
              <Button variant="secondary">选择插件 zip 包</Button>
            </Upload>
            <Input
              style={{ width: 260 }}
              placeholder="备注（可选，如：发版流程助手）"
              value={uploadNotes}
              onChange={(e) => setUploadNotes(e.target.value)}
            />
          </Space>
        </Space>
      </Modal>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} /> : null}
      {notice ? <Alert type="success" showIcon message={notice} style={{ marginBottom: 8 }} /> : null}

      {shown === null ? (
        <SkeletonList count={4} />
      ) : shown.length === 0 ? (
        <Empty text={tab === 'market' ? '暂无匹配插件（管理员可在管理端发布插件包）' : '尚未安装任何插件'} />
      ) : (
        <Flex wrap="wrap" gap={12}>
          {shown.map((e) => {
            const policy = POLICY_META[e.policy];
            // 本机对账（见 localById/serverIds）：服务端记为已装但本机无安装目录
            // =更换设备/文件被移除——Agent 当前用不了
            const onDevice = !DESKTOP || localById.has(e.plugin_id);
            const localOnly = isLocalOnly(e.plugin_id);
            const missingOnDevice = e.installed && !onDevice;
            return (
              <Card
                key={e.plugin_id}
                size="small"
                hoverable
                style={{ width: 320 }}
                onClick={() => openDetail(e)}
                data-testid={`bbc-plugin-card-${e.plugin_id}`}
              >
                <Flex align="center" gap={8} wrap>
                  <Typography.Text strong ellipsis style={{ minWidth: 0 }}>
                    {e.name}
                  </Typography.Text>
                  {policy?.label ? <Tag color={policy.color}>{policy.label}</Tag> : null}
                  {e.manifest?.usesIdentity ? (
                    <Tag color="gold" title="将以你的身份调用系统">
                      <ShieldAlert size={11} /> 身份
                    </Tag>
                  ) : null}
                  {e.owner_user_id ? (
                    <Tag title="个人插件：仅自己可见可装；管理员审核后进公共市场">个人</Tag>
                  ) : null}
                  {e.owner_user_id && e.status === 'draft' ? (
                    <Tag color="gold" title="未发布：仅自用沙盒">
                      自用
                    </Tag>
                  ) : null}
                  {localOnly ? (
                    <Tag
                      color="orange"
                      title="本机已安装且对 Agent 生效，但服务端没有安装记录（数据重置、更换账号或记录被清除后的遗留）。可在此禁用或卸载"
                    >
                      仅本机
                    </Tag>
                  ) : null}
                  {missingOnDevice ? (
                    <Tag color="orange" title="服务端有安装记录，但本机没有安装文件（更换设备或文件被移除）——Agent 当前不可用">
                      本机未装
                    </Tag>
                  ) : null}
                </Flex>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                  {e.plugin_id} · v{e.current_version}
                  {e.installed && onDevice
                    ? `（本地 v${localById.get(e.plugin_id)?.activeVersion ?? e.version}）`
                    : ''}
                  {/* D39：装机数（个人插件不展示——仅本人可装无参考意义） */}
                  {!e.owner_user_id && e.installs > 0 ? ` · ${e.installs} 人安装` : ''}
                </Typography.Text>
                {e.description ? (
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
                    {e.description}
                  </Typography.Paragraph>
                ) : null}
                <BadgeTags e={e} />
                <Space size={8} wrap style={{ marginTop: 8 }}>
                  {!e.installed || e.has_update || missingOnDevice ? (
                    <Button
                      loading={busyId === e.plugin_id}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        doInstall(e);
                      }}
                      data-testid={`bbc-plugin-install-${e.plugin_id}`}
                    >
                      {e.has_update ? <RefreshCw size={12} /> : <Download size={12} />}
                      {e.has_update ? '更新' : missingOnDevice ? '装到本机' : '安装'}
                    </Button>
                  ) : null}
                  {e.installed ? (
                    <Button
                      variant="secondary"
                      disabled={busyId === e.plugin_id}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        doUninstall(e);
                      }}
                    >
                      <Trash2 size={12} /> 卸载
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      openDetail(e);
                    }}
                  >
                    详情
                  </Button>
                </Space>
              </Card>
            );
          })}
        </Flex>
      )}

      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        width="50%"
        destroyOnClose
        title={
          detail ? (
            <Space size={8}>
              {detail.plugin.name}
              <Typography.Text type="secondary" code>
                {detail.plugin.plugin_id}
              </Typography.Text>
            </Space>
          ) : ''
        }
        aria-label={detail ? `${detail.plugin.name} 详情` : undefined}
      >
        {detail ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {detail.plugin.manifest?.description || detail.plugin.description}
            </Typography.Paragraph>

            {/* 仅本机（对账）：本机已装且对 Agent 生效，服务端无安装记录 */}
            {isLocalOnly(detail.plugin.plugin_id) ? (
              <Alert
                type="warning"
                showIcon
                message="仅本机：服务端没有这条安装记录，但本机已安装且对 Agent 生效。可在此禁用或卸载"
              />
            ) : null}

            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {/* D39：最近更新 + 装机数（个人插件不展示装机数） */}
              {detail.plugin.updated_at ? `最近更新 ${fmtDate(detail.plugin.updated_at)}` : ''}
              {!detail.plugin.owner_user_id && detail.plugin.installs > 0
                ? `${detail.plugin.updated_at ? ' · ' : ''}${detail.plugin.installs} 人安装`
                : ''}
            </Typography.Text>

            {/* D39：README 说明区块（MarkdownText 渲染；远程图片占位防 beacon） */}
            {detail.plugin.readme ? (
              <div>
                <Typography.Text strong>说明</Typography.Text>
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  <MarkdownText text={detail.plugin.readme} blockRemoteImages />
                </div>
              </div>
            ) : null}

            {local && localInstalled ? (
              <div>
                <Typography.Text strong>本地状态</Typography.Text>
                <div style={{ marginTop: 8 }}>
                  <Space size={8} align="center">
                    <Switch
                      checked={local.enabled}
                      disabled={busyId === detail.plugin.plugin_id}
                      onChange={(checked) => doToggle(detail.plugin, checked)}
                    />
                    <span>
                      {local.enabled ? '已启用' : '已禁用'}（v{local.activeVersion}
                      {local.versions.length > 1 ? `，共 ${local.versions.length} 版` : ''}）
                    </span>
                  </Space>
                </div>
              </div>
            ) : null}

            {/* 用户侧身份开关（2026-11-25 拍板）：HTTP MCP 以我的身份调用；
                作者声明 usesIdentity 的恒注入——只读展示（声明优先，D22 §6.3/D38） */}
            {local && localInstalled && (identityTargets.length > 0 || detail.plugin.manifest?.usesIdentity) ? (
              <div>
                <Typography.Text strong>身份调用</Typography.Text>
                <div style={{ marginTop: 8 }}>
                  <Space size={8} align="center">
                    <Switch
                      checked={detail.plugin.manifest?.usesIdentity ? true : !!local.useIdentity}
                      disabled={
                        !!detail.plugin.manifest?.usesIdentity || busyId === detail.plugin.plugin_id
                      }
                      onChange={(checked) => toggleIdentity(detail.plugin.plugin_id, checked)}
                    />
                    <span>
                      {detail.plugin.manifest?.usesIdentity
                        ? '插件声明：将以你的身份调用（卸载/禁用即停止注入）'
                        : local.useIdentity
                          ? '已开启（HTTP MCP 自动注入登录凭证）'
                          : '未开启（匿名调用；HTTP server 可开启）'}
                    </span>
                  </Space>
                  {identityTargets.length ? (
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12, display: 'block', marginTop: 4 }}
                    >
                      目的地：{identityTargets.join('、')}
                    </Typography.Text>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div>
              <Typography.Text strong>组件</Typography.Text>
              <div style={{ marginTop: 8 }}>
                <BadgeTags e={detail.plugin} />
                {componentBadges(detail.plugin).length === 0 ? (
                  <Typography.Text type="secondary">无（信息缺失）</Typography.Text>
                ) : null}
              </div>
            </div>

            <div>
              <Typography.Text strong>权限声明</Typography.Text>
              <List
                size="small"
                split={false}
                style={{ marginTop: 4 }}
                dataSource={[
                  <span key="risk">风险级：{detail.plugin.manifest?.risk ?? 'medium'}</span>,
                  ...(detail.plugin.manifest?.usesIdentity
                    ? [
                        <Typography.Text key="identity" type="warning">
                          <ShieldAlert size={12} /> 将以你的身份调用系统（自动注入登录凭证）
                        </Typography.Text>,
                      ]
                    : []),
                  ...(detail.plugin.manifest?.netAllow?.length
                    ? [<span key="net">网络访问：{detail.plugin.manifest.netAllow.join('、')}（v0.1 声明展示，强制执行阶段二）</span>]
                    : []),
                  ...(detail.plugin.manifest?.configKeys?.length
                    ? [<span key="cfg">需要配置：{detail.plugin.manifest.configKeys.join('、')}</span>]
                    : []),
                  <span key="gate">全部工具调用与内置工具同一审批门控（无特权）</span>,
                ]}
                renderItem={(item: ReactNode) => (
                  <List.Item style={{ padding: '2px 0', fontSize: 13 }}>{item}</List.Item>
                )}
              />
            </div>

            {configFormKeys.length ? (
              <div>
                <Typography.Text strong>配置</Typography.Text>
                {detail.plugin.manifest?.configKeys?.length ? null : (
                  <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                    从 MCP 配置自动发现（${'{CONFIG:key}'} 占位）——填写后保存即注入调用
                  </Typography.Text>
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                  认证类配置可点输入框旁「平台凭证」——调用时自动注入平台签发的身份票据（仅平台生态内服务可验证；第三方系统请粘贴其签发的 token）
                </Typography.Text>
                <Form layout="vertical" style={{ marginTop: 8 }}>
                  {configFormKeys.map(({ key, secret }) => {
                    const authLike = secret || AUTH_KEY_RE.test(key);
                    const quickFill = hasHttpServer && authLike;
                    return (
                      <Form.Item key={key} label={<Typography.Text code>{key}</Typography.Text>}>
                        <Input.Password
                          value={configDraft[key] ?? ''}
                          placeholder={authLike ? '敏感值，保存后存入系统钥匙串' : ''}
                          onChange={(ev) => setConfigDraft((prev) => ({ ...prev, [key]: ev.target.value }))}
                          addonAfter={
                            quickFill ? (
                              <Button
                                variant="text"
                                size="small"
                                icon={<KeyRound size={12} aria-hidden />}
                                title="填入平台凭证——调用时自动注入平台签发的身份票据（仅平台生态内服务可验证）"
                                onClick={() => setConfigDraft((prev) => ({ ...prev, [key]: PLATFORM_TOKEN }))}
                              >
                                平台凭证
                              </Button>
                            ) : undefined
                          }
                        />
                        {configDraft[key] === PLATFORM_TOKEN ? (
                          <Tag
                            icon={<KeyRound size={11} aria-hidden />}
                            closable
                            onClose={() => setConfigDraft((prev) => ({ ...prev, [key]: '' }))}
                            style={{ marginTop: 4 }}
                          >
                            平台凭证 · 调用时自动注入
                          </Tag>
                        ) : null}
                      </Form.Item>
                    );
                  })}
                </Form>
                <Button disabled={busyId === detail.plugin.plugin_id} onClick={() => saveConfig(detail.plugin.plugin_id)}>
                  保存配置
                </Button>
                {needIdentityHint && detail ? (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginTop: 8 }}
                    message="已填平台凭证，但「以我的身份调用」未开启——调用时占位将替换为空（匿名请求）"
                    action={
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={busyId === detail.plugin.plugin_id}
                        onClick={() => toggleIdentity(detail.plugin.plugin_id, true)}
                      >
                        一键开启
                      </Button>
                    }
                  />
                ) : null}
              </div>
            ) : null}

            <div>
              <Typography.Text strong>版本</Typography.Text>
              <List
                size="small"
                style={{ marginTop: 4 }}
                dataSource={detail.versions}
                rowKey="id"
                renderItem={(v) => (
                  <List.Item style={{ padding: '4px 0', fontSize: 13 }}>
                    v{v.version}
                    {v.version === detail.plugin.current_version ? '（当前）' : ''}
                    {v.notes ? ` — ${v.notes}` : ''}
                  </List.Item>
                )}
              />
            </div>
          </Space>
        ) : null}
      </Drawer>
      </div>
    </div>
  );
}
