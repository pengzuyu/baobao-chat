/**
 * 管理端·应用管理（D09 PEC-01..03 务实版 / E1）：登记（app_id+首版 manifest）
 * + 版本线（追加/发布）+ 下架 + 灰度（E2/OQ-B13：canary % 确定性放量+白名单
 * 100% 豁免——Catalog 按灰度收敛、Install 服务端闸门）。C 档双人审批与签名链
 * 随 E3（发布=直发，admin:app:publish 路由承担）；回滚=发布旧版。
 * D26-O2：Table（expandable 版本线）/Input/TextArea/Tag/Alert/Modal（灰度）化。
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Flex, Input, InputNumber, Modal, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Package, Plus, Upload } from 'lucide-react';
import { http, errText } from '../../../shared/api/http';
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
  // 展开应用版本线（Table expandable）
  const [openApp, setOpenApp] = useState<string | null>(null);
  const [versions, setVersions] = useState<AdminAppVersion[] | null>(null);
  const [versionsOfApp, setVersionsOfApp] = useState<string | null>(null);
  const [newVer, setNewVer] = useState('');
  // 灰度弹窗（E2/OQ-B13）
  const [rolloutFor, setRolloutFor] = useState<{ appId: string; versionId: string } | null>(null);
  const [canaryPct, setCanaryPct] = useState<number>(100);
  const [whitelist, setWhitelist] = useState(''); // 逗号分隔 uid

  const openRollout = (appId: string, versionId: string) => {
    setRolloutFor({ appId, versionId });
    void http
      .get<{ canary_pct: number; whitelist: number[] }>(`/admin/eco/apps/${encodeURIComponent(appId)}/rollout`)
      .then((r) => {
        setCanaryPct(r.canary_pct ?? 100);
        setWhitelist((r.whitelist ?? []).join(','));
      })
      .catch(() => undefined);
  };

  const saveRollout = () => {
    if (!rolloutFor) return;
    const wl = whitelist.split(/[,\s，]+/).map((x) => x.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    setBusy(true);
    void http
      .put(`/admin/eco/apps/${encodeURIComponent(rolloutFor.appId)}/rollout`, {
        version_row_id: rolloutFor.versionId,
        canary_pct: canaryPct,
        whitelist: wl,
      })
      .then(() => setRolloutFor(null))
      .catch((e) => setError(errText(e, '灰度设置失败')))
      .finally(() => setBusy(false));
  };

  const reload = useCallback(() => {
    setError('');
    http
      .get<{ items: AdminApp[] }>('/admin/eco/apps')
      .then((d) => setApps(d.items ?? []))
      .catch((e) => {
        setApps([]);
        setError(errText(e, '加载失败'));
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
      .catch((e) => setError(errText(e, '登记失败')))
      .finally(() => setBusy(false));
  };

  const openVersions = (id: string) => {
    setOpenApp(id);
    setVersions(null);
    setVersionsOfApp(id);
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
      .catch((e) => setError(errText(e, '版本追加失败')))
      .finally(() => setBusy(false));
  };

  const publish = (id: string, vid: string) => {
    Modal.confirm({
      title: '发布该版本？',
      content: '发布后全员商店可见、安装用户收升级（v0.1 直发——C 档审批随 E2/E3）',
      okText: '发布',
      cancelText: '取消',
      onOk: () =>
        http
          .post(`/admin/eco/apps/${encodeURIComponent(id)}/versions/${encodeURIComponent(vid)}/publish`, {})
          .then(reload)
          .catch((e) => {
            setError(errText(e, '发布失败'));
            throw e;
          }),
    });
  };

  const delist = (id: string, appName: string) => {
    Modal.confirm({
      title: `下架「${appName}」？`,
      content: '已安装用户的应用即刻失效（app.revoked）',
      okText: '下架',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () =>
        http
          .post(`/admin/eco/apps/${encodeURIComponent(id)}/delist`, {})
          .then(reload)
          .catch((e) => {
            setError(errText(e, '下架失败'));
            throw e;
          }),
    });
  };

  const columns: ColumnsType<AdminApp> = [
    {
      title: '应用',
      dataIndex: 'name',
      render: (_, a) => (
        <div>
          <Space size={4}>
            <Package size={13} /> {a.name}
          </Space>
          {a.description ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
              {a.description}
            </Typography.Paragraph>
          ) : null}
        </div>
      ),
    },
    { title: 'app_id', dataIndex: 'app_id' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => (
        <Tag color={v === 'published' ? 'geekblue' : v === 'delisted' ? 'red' : 'default'}>
          {v === 'published' ? '已发布' : v === 'delisted' ? '已下架' : '草稿'}
        </Tag>
      ),
    },
    { title: '当前版本', dataIndex: 'current_version', width: 100, render: (v: string) => v || '—' },
    {
      title: '操作',
      key: 'ops',
      width: 140,
      render: (_, a) => (
        <>
          <Button variant="text" size="small" onClick={() => (openApp === a.id ? setOpenApp(null) : openVersions(a.id))} data-testid={`eco-versions-${a.id}`}>
            版本
          </Button>
          {a.status !== 'delisted' ? (
            <Button variant="danger" size="small" disabled={busy} onClick={() => delist(a.id, a.name)}>
              下架
            </Button>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <div data-testid="admin-eco-apps">
      <Flex align="center" gap={8} style={{ marginBottom: 16 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          应用管理
        </Typography.Title>
        <span style={{ flex: 1 }} />
        <Button onClick={() => setRegOpen((v) => !v)} data-testid="eco-reg-btn">
          <Plus size={14} /> 登记应用
        </Button>
      </Flex>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} /> : null}

      {regOpen ? (
        <Space direction="vertical" size={8} style={{ marginBottom: 12, width: '100%' }}>
          <Space size={8} wrap>
            <Input placeholder="app_id（如 crm.sync）" style={{ width: 220 }} value={appID} onChange={(e) => setAppID(e.target.value)} data-testid="eco-reg-appid" />
            <Input placeholder="显示名" style={{ width: 160 }} value={name} onChange={(e) => setName(e.target.value)} />
            <Input placeholder="首版版本（x.y.z）" style={{ width: 140 }} value={version} onChange={(e) => setVersion(e.target.value)} />
          </Space>
          <Input placeholder="描述（可选）" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <Input.TextArea
            placeholder="AppManifest JSON（工具/技能清单）"
            value={manifest}
            onChange={(e) => setManifest(e.target.value)}
            autoSize={{ minRows: 6, maxRows: 14 }}
            data-testid="eco-reg-manifest"
          />
          <Button loading={busy} disabled={!appID.trim() || !name.trim()} onClick={register} data-testid="eco-reg-submit">
            登记并建首版（draft）
          </Button>
        </Space>
      ) : null}

      {apps === null ? (
        <Typography.Text type="secondary">加载中…</Typography.Text>
      ) : apps.length === 0 ? (
        <Typography.Text type="secondary">暂无应用——点「登记应用」发布第一个生态应用</Typography.Text>
      ) : (
        <Table<AdminApp>
          rowKey="id"
          columns={columns}
          dataSource={apps}
          data-testid="eco-apps-table"
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          expandable={{
            expandedRowKeys: openApp ? [openApp] : [],
            onExpand: (expanded, a) => (expanded ? openVersions(a.id) : setOpenApp(null)),
            expandedRowRender: (a) =>
              versionsOfApp === a.id && versions !== null ? (
                <Space direction="vertical" size={4}>
                  {versions.map((v) => (
                    <Space key={v.id} size={8} wrap>
                      <span>v{v.version}</span>
                      <Tag color={v.status === 'published' ? 'geekblue' : 'default'}>
                        {v.status === 'published' ? '已发布' : v.status === 'rolled_back' ? '已回滚' : '草稿'}
                      </Tag>
                      {v.high_risk ? <Tag color="red">高危</Tag> : null}
                      {v.status !== 'published' ? (
                        <Button variant="text" size="small" disabled={busy} onClick={() => publish(a.id, v.id)} data-testid={`eco-publish-${v.id}`}>
                          发布
                        </Button>
                      ) : null}
                      <Button variant="text" size="small" disabled={busy} onClick={() => openRollout(a.id, v.id)} data-testid={`eco-rollout-${v.id}`}>
                        灰度
                      </Button>
                    </Space>
                  ))}
                  <Space size={8} wrap>
                    <Input placeholder="新版本号（x.y.z）" style={{ width: 200 }} value={newVer} onChange={(e) => setNewVer(e.target.value)} data-testid="eco-newver" />
                    <Button loading={busy} disabled={!newVer.trim()} onClick={() => addVersion(a.id)}>
                      <Upload size={12} /> 追加版本（draft）
                    </Button>
                  </Space>
                </Space>
              ) : (
                <Typography.Text type="secondary">版本线加载中…</Typography.Text>
              ),
          }}
        />
      )}

      {/* 灰度设置弹窗（E2/OQ-B13） */}
      <Modal
        open={!!rolloutFor}
        title={`灰度（v 目标版本行 ${rolloutFor?.versionId ?? ''}）`}
        onCancel={() => setRolloutFor(null)}
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setRolloutFor(null)}>
            取消
          </Button>,
          <Button key="save" loading={busy} onClick={saveRollout} data-testid="eco-rollout-save">
            应用
          </Button>,
        ]}
      >
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }} data-testid="eco-rollout-panel">
          <label>canary %（0-100 整数）</label>
          <InputNumber min={0} max={100} precision={0} value={canaryPct} onChange={(v) => setCanaryPct(v ?? 100)} style={{ width: 160 }} data-testid="eco-canary-input" />
          <label>白名单（逗号分隔 uid，100% 豁免）</label>
          <Input value={whitelist} onChange={(e) => setWhitelist(e.target.value)} placeholder="10001,10002" data-testid="eco-whitelist-input" />
          <span>确定性放量 uid%100&lt;pct；未入灰度未装=不可见，已装=保持当前版；100=全量</span>
        </div>
      </Modal>
    </div>
  );
}
