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
  Alert, Card, Drawer, Flex, Form, Input, List, Modal, Select, Space, Switch, Tabs, Tag, Typography, Upload,
} from 'antd';
import type { UploadFile } from 'antd';
import {
  Bot, CheckCircle2, Download, Package, Puzzle, RefreshCw, Search, ShieldAlert, Sparkles, Terminal, Trash2, Upload as UploadIcon, Wrench,
} from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { Empty } from '../../../shared/ui/Empty';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import {
  fetchLocalState, fetchMyPlugins, fetchPluginCatalog, fetchPluginDetail,
  installPlugin, setPluginEnabled, uninstallPlugin, uploadMyPlugin, writePluginConfig,
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

const POLICY_META: Record<number, { label: string; color: string }> = {
  1: { label: '企业已推', color: 'green' },
  2: { label: '推荐', color: 'gold' },
  3: { label: '', color: '' },
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
            {usesIdentity ? <div>⚠️ 该插件将以你的身份调用系统（自动注入登录凭证）</div> : null}
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
        reload();
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
        uninstallPlugin(e.plugin_id, true)
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
    void fetchPluginDetail(e.plugin_id)
      .then(setDetail)
      .catch((err) => setError(`详情加载失败：${err instanceof Error ? err.message : '未知错误'}`));
  };

  const saveConfig = (pluginId: string) => {
    setBusyId(pluginId);
    void writePluginConfig(pluginId, configDraft, detail?.plugin.manifest?.configSecrets ?? [])
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
    <div data-testid="bbc-plugin">
      <Flex align="center" gap={8} style={{ marginBottom: 8 }} wrap>
        <Puzzle size={16} />
        <Typography.Title level={5} style={{ margin: 0 }}>
          插件
        </Typography.Title>
        <Typography.Text type="secondary">安装即得 Agent 新能力：技能 / 工具 / 命令 / 专家一包携带（生效随新会话）</Typography.Text>
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
                {entries?.length !== undefined && tab === 'installed' ? `（${entries.length}）` : ''}
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

      {uploadOpen ? (
        <Card size="small" title="上传个人插件（zip ≤10MB）" style={{ marginBottom: 12 }}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              上传后进入个人区：仅自己可见可装；进公共市场需管理员审核发布
            </Typography.Text>
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
            <Space size={8}>
              <Button disabled={!uploadFile || uploading} loading={uploading} onClick={doUpload}>
                <UploadIcon size={12} /> 上传
              </Button>
              <Button variant="secondary" disabled={uploading} onClick={() => setUploadOpen(false)}>
                取消
              </Button>
            </Space>
          </Space>
        </Card>
      ) : null}

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
                </Flex>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                  {e.plugin_id} · v{e.current_version}
                  {e.installed && e.version ? `（本地 v${e.version}）` : ''}
                </Typography.Text>
                {e.description ? (
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
                    {e.description}
                  </Typography.Paragraph>
                ) : null}
                <BadgeTags e={e} />
                <Space size={8} wrap style={{ marginTop: 8 }}>
                  {!e.installed || e.has_update ? (
                    <Button
                      loading={busyId === e.plugin_id}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        doInstall(e);
                      }}
                      data-testid={`bbc-plugin-install-${e.plugin_id}`}
                    >
                      {e.has_update ? <RefreshCw size={12} /> : <Download size={12} />}
                      {e.has_update ? '更新' : '安装'}
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
        width={480}
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

            {detail.plugin.installed && local ? (
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

            {detail.plugin.manifest?.configKeys?.length ? (
              <div>
                <Typography.Text strong>配置</Typography.Text>
                <Form layout="vertical" style={{ marginTop: 8 }}>
                  {detail.plugin.manifest.configKeys.map((key) => (
                    <Form.Item key={key} label={<Typography.Text code>{key}</Typography.Text>}>
                      <Input.Password
                        value={configDraft[key] ?? ''}
                        placeholder={/token|secret|key/i.test(key) ? '敏感值，保存后存入系统钥匙串' : ''}
                        onChange={(ev) => setConfigDraft((prev) => ({ ...prev, [key]: ev.target.value }))}
                      />
                    </Form.Item>
                  ))}
                </Form>
                <Button disabled={busyId === detail.plugin.plugin_id} onClick={() => saveConfig(detail.plugin.plugin_id)}>
                  保存配置
                </Button>
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
  );
}
