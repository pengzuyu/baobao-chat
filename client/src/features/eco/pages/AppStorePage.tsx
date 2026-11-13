/**
 * 应用商店（D09 PEC-07 / E1）：应用 catalog 差异视图——可安装/可升级/已装/已撤销
 * 四态卡流；安装/升级/卸载即时生效；tools.reload 热加载随宿主命令阶段二（登记）。
 * 灰度（E2）与签名链（10 §7）接入后本页自动透出对应态。
 * 技能市场已并入插件页（D22 决策③：/agent/plugins 超集，SkillTab 删除）。
 * D26-O3：eco-store/eco-card 自研结构退役——卡片→Card、状态标→Tag、
 * error 条→Alert、卸载 window.confirm→Modal.confirm（danger）。
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, Flex, Modal, Space, Tag, Typography } from 'antd';
import { Download, Package, RotateCcw } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { Empty } from '../../../shared/ui/Empty';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { fetchCatalog, installApp, uninstallApp, type CatalogEntry } from '../api/apps';

const ACTION_META: Record<CatalogEntry['action'], { label: string; color: string }> = {
  install: { label: '可安装', color: 'green' },
  upgrade: { label: '可升级', color: 'gold' },
  noop: { label: '已安装', color: 'default' },
  revoke: { label: '已下架', color: 'red' },
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
    Modal.confirm({
      title: '卸载该应用？',
      content: '卸载后该应用的工具将从 Agent 注册表移除（进行中调用将失败）',
      okText: '卸载',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () =>
        uninstallApp(id)
          .then(reload)
          .catch(() => setError('卸载失败'))
          .finally(() => setBusyId(null)),
    });
  };

  return (
    <div data-testid="eco-store">
      <Flex align="center" gap={8} style={{ marginBottom: 8 }} wrap>
        <Package size={16} />
        <Typography.Title level={5} style={{ margin: 0 }}>
          应用
        </Typography.Title>
        <Typography.Text type="secondary">管理员发布的应用与工具集；安装后 Agent 工具注册表同步（热加载随阶段二）</Typography.Text>
      </Flex>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} /> : null}
      {entries === null ? (
        <SkeletonList count={4} />
      ) : entries.length === 0 ? (
        <Empty text="暂无已发布应用（管理员可在管理端「应用」登记发布）" />
      ) : (
        <Flex wrap="wrap" gap={12}>
          {entries.map((e) => {
            const meta = ACTION_META[e.action];
            return (
              <Card key={e.id} size="small" style={{ width: 320 }} data-testid="eco-app-card">
                <Flex align="center" justify="space-between" gap={8}>
                  <Typography.Text strong ellipsis style={{ minWidth: 0 }}>
                    {e.name}
                  </Typography.Text>
                  <Tag color={meta.color}>{meta.label}</Tag>
                </Flex>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                  {e.app_id} · v{e.current_version}
                  {e.installed_v && e.action === 'upgrade' ? `（本地 v${e.installed_v}）` : ''}
                </Typography.Text>
                {e.description ? (
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
                    {e.description}
                  </Typography.Paragraph>
                ) : null}
                <Space size={8} wrap style={{ marginTop: 8 }}>
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
                  {e.action === 'revoke' ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      应用已下架，本地副本失效
                    </Typography.Text>
                  ) : null}
                </Space>
              </Card>
            );
          })}
        </Flex>
      )}
    </div>
  );
}
