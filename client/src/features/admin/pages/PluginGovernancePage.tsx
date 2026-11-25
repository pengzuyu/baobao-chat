/**
 * 管理端·插件治理（D22 §3.2 管理面 / 方案 A 审核台）：
 * - 列表全量（公共 + 个人提交——owner 列透出）
 * - 上传公共插件（multipart zip + 三档策略；与插件页个人上传通道分离）
 * - 版本线展开 → 逐版本「发布进公共市场」（方案 A 审核动作：个人插件 draft
 *   经此进公共；owner 视角不变）
 * - 下架 / policy 调整（force=全员推发免确认、recommend 置顶、optional）
 * D26-O2：Table（expandable 版本线）/Upload/Select/Tag/Alert/Modal.confirm 化。
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Flex, Input, Modal, Select, Space, Table, Tag, Typography, Upload } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UploadFile } from 'antd';
import { Package, Plus, Puzzle, Upload as UploadIcon } from 'lucide-react';
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
  /** D39：当前装机人数（治理信号——哪些插件没人用） */
  installs: number;
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

const POLICY_OPTIONS = [
  { value: 1, label: POLICY_LABEL[1] },
  { value: 2, label: POLICY_LABEL[2] },
  { value: 3, label: POLICY_LABEL[3] },
];

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
  // 版本线展开行（Table expandable）
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
    setVerRow(p.plugin_id);
    setVersions([]);
    http
      .get<{ items: VersionRow[] }>(`/admin/eco/plugins/${encodeURIComponent(p.plugin_id)}/versions`)
      .then((d) => setVersions(d.items ?? []))
      .catch((e) => setError(errText(e, '版本线加载失败')));
  };

  const publishVersion = (pluginId: string, version: string) => {
    Modal.confirm({
      title: `发布 ${pluginId} v${version} 进公共市场？`,
      content: '所有用户将可见可装',
      okText: '发布',
      cancelText: '取消',
      onOk: () =>
        http
          .post(`/admin/eco/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}/publish`, {})
          .then(() => {
            setNotice(`${pluginId} v${version} 已发布进公共市场`);
            reload();
          })
          .catch((e) => {
            setError(`发布失败：${errText(e, '未知错误')}`);
            throw e;
          }),
    });
  };

  const delist = (p: PluginRow) => {
    Modal.confirm({
      title: `下架「${p.name}」？`,
      content: '已装用户本地副本失效（catalog 不再可见）',
      okText: '下架',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () =>
        http
          .post(`/admin/eco/plugins/${encodeURIComponent(p.plugin_id)}/delist`, {})
          .then(() => {
            setNotice(`${p.name} 已下架`);
            reload();
          })
          .catch((e) => {
            setError(`下架失败：${errText(e, '未知错误')}`);
            throw e;
          }),
    });
  };

  const setPolicy = (pluginId: string, policy: number) => {
    setBusy(true);
    void http
      .patch(`/admin/eco/plugins/${encodeURIComponent(pluginId)}`, { policy })
      .then(reload)
      .catch((e) => setError(`策略调整失败：${errText(e, '未知错误')}`))
      .finally(() => setBusy(false));
  };

  const columns: ColumnsType<PluginRow> = [
    {
      title: '插件',
      dataIndex: 'name',
      render: (_, p) => (
        <div>
          <Space size={4}>
            <Puzzle size={13} /> {p.name}
          </Space>
          {p.description ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
              {p.description}
            </Typography.Paragraph>
          ) : null}
        </div>
      ),
    },
    { title: 'plugin_id', dataIndex: 'plugin_id' },
    {
      title: '来源',
      key: 'owner',
      width: 130,
      render: (_, p) =>
        p.owner_user_id ? (
          <Tag color="gold">个人（uid {p.owner_user_id}）</Tag>
        ) : (
          <Tag color="geekblue">公共</Tag>
        ),
    },
    {
      title: '组件',
      key: 'components',
      render: (_, p) => (
        <div>
          {p.manifest
            ? `技能${p.manifest.components.skills}·工具${p.manifest.components.mcpServers}·命令${p.manifest.components.commands}·专家${p.manifest.components.agents}`
            : '—'}
          {p.manifest?.usesIdentity ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
              ⚠ 使用用户身份
            </Typography.Paragraph>
          ) : null}
        </div>
      ),
    },
    {
      title: '策略',
      dataIndex: 'policy',
      width: 170,
      render: (_, p) => (
        <Select
          size="small"
          style={{ width: 150 }}
          value={p.policy}
          disabled={busy || p.owner_user_id !== 0}
          onChange={(v) => setPolicy(p.plugin_id, v)}
          options={POLICY_OPTIONS}
          title={p.owner_user_id !== 0 ? '个人插件恒 optional' : undefined}
        />
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => (
        <Tag color={v === 'published' ? 'geekblue' : v === 'delisted' ? 'red' : 'default'}>
          {v === 'published' ? '已上架' : v === 'delisted' ? '已下架' : '草稿'}
        </Tag>
      ),
    },
    { title: '版本', dataIndex: 'current_version', width: 90, render: (v: string) => `v${v || '—'}` },
    // D39：装机数（当前装机口径：每用户一行去重、卸载即减；个人插件通常 ≤1）
    { title: '装机', dataIndex: 'installs', width: 80, render: (v: number) => String(v ?? 0) },
    {
      title: '操作',
      key: 'ops',
      width: 150,
      render: (_, p) => (
        <>
          <Button variant="text" size="small" onClick={() => (verRow === p.plugin_id ? setVerRow(null) : openVersions(p))} data-testid={`plugin-vers-${p.plugin_id}`}>
            版本线
          </Button>
          {p.status !== 'delisted' ? (
            <Button variant="danger" size="small" disabled={busy} onClick={() => delist(p)}>
              下架
            </Button>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <div data-testid="admin-plugins">
      <Flex align="center" gap={8} style={{ marginBottom: 16 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          插件
        </Typography.Title>
        <span style={{ flex: 1 }} />
        <Button onClick={() => setPubOpen((v) => !v)} data-testid="plugin-pub-btn">
          <Plus size={14} /> 上传公共插件
        </Button>
      </Flex>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} /> : null}
      {notice ? <Alert type="success" showIcon message={notice} style={{ marginBottom: 8 }} /> : null}

      {pubOpen ? (
        <Space direction="vertical" size={8} style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary">
            公共插件（全员可见；policy=force 时用户端免确认自动推装）。个人插件请走插件页「上传插件」
          </Typography.Text>
          <Upload
            accept=".zip"
            maxCount={1}
            beforeUpload={(file) => {
              setPubFile(file);
              return false;
            }}
            onRemove={() => setPubFile(null)}
            fileList={pubFile ? ([{ uid: '-1', name: pubFile.name, status: 'done' }] as UploadFile[]) : []}
          >
            <Button variant="secondary">选择插件 zip 包</Button>
          </Upload>
          <Space size={8} wrap>
            <Input style={{ width: 220 }} placeholder="备注（可选）" value={pubNotes} onChange={(e) => setPubNotes(e.target.value)} />
            <Select
              style={{ width: 180 }}
              value={pubPolicy}
              onChange={setPubPolicy}
              title="三档策略"
              options={POLICY_OPTIONS}
            />
          </Space>
          <Button loading={uploading} disabled={!pubFile} onClick={uploadPublic} data-testid="plugin-pub-submit">
            <UploadIcon size={12} /> 上传（draft）
          </Button>
        </Space>
      ) : null}

      {plugins === null ? (
        <Typography.Text type="secondary">加载中…</Typography.Text>
      ) : plugins.length === 0 ? (
        <Typography.Text type="secondary">暂无插件（用户个人上传也会出现在这里待审核）</Typography.Text>
      ) : (
        <Table<PluginRow>
          rowKey="id"
          columns={columns}
          dataSource={plugins}
          data-testid="admin-plugins-table"
          scroll={{ x: 1100 }}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          expandable={{
            expandedRowKeys: verRow ? [verRow] : [],
            onExpand: (expanded, p) => {
              if (expanded) openVersions(p);
              else setVerRow(null);
            },
            expandedRowRender: (p) =>
              versions.length === 0 ? (
                <Typography.Text type="secondary">无版本行（包体缺失？）</Typography.Text>
              ) : (
                <Space direction="vertical" size={4}>
                  {versions.map((v) => (
                    <Space key={v.id} size={8} wrap>
                      <span>
                        v{v.version}
                        {v.version === p.current_version ? '（当前）' : ''}
                      </span>
                      <Typography.Text type="secondary">{v.notes || '—'}</Typography.Text>
                      {v.version !== p.current_version || p.status !== 'published' ? (
                        <Button disabled={busy} onClick={() => publishVersion(p.plugin_id, v.version)} data-testid={`plugin-pubver-${p.plugin_id}-${v.version}`}>
                          <Package size={12} /> 发布进公共市场
                        </Button>
                      ) : null}
                    </Space>
                  ))}
                </Space>
              ),
          }}
        />
      )}
    </div>
  );
}
