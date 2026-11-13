/**
 * 设置 · 关于（D01 §4.2）：版本、更新、技术栈与设计文档索引。
 * 版本号取 package.json（scripts/release/set-version.sh 与 tauri.conf.json 等四处对齐）。
 * 更新区块（D21）：检查更新 → 下载（进度）→ 重启安装（plugin-process relaunch）；
 * Linux deb/rpm 装机（非 AppImage）不支持应用内自更新——出错时给官网下载引导。
 * D26-O3：品牌区/信息行→Card+Flex+List、错误条→Alert（about-、settings- 系自研类退役）。
 */

import { Alert, Card, Flex, List, Progress, Space, Tag, Typography } from 'antd';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '../../../shared/ui/Button';
import pkg from '../../../../package.json';
import { Logo } from '../../../shared/ui/Logo';
import { apiOrigin } from '../../../shared/api/http';
import { useUpdaterStore } from '../updater';

const MB = 1024 * 1024;

/** 更新卡片（订阅 updater store 全量——字段少无所谓精细订阅） */
function UpdateCard() {
  const checking = useUpdaterStore((s) => s.checking);
  const downloading = useUpdaterStore((s) => s.downloading);
  const progress = useUpdaterStore((s) => s.progress);
  const available = useUpdaterStore((s) => s.available);
  const readyToInstall = useUpdaterStore((s) => s.readyToInstall);
  const upToDate = useUpdaterStore((s) => s.upToDate);
  const error = useUpdaterStore((s) => s.error);
  const manualCheck = useUpdaterStore((s) => s.manualCheck);
  const download = useUpdaterStore((s) => s.download);
  const installAndRelaunch = useUpdaterStore((s) => s.installAndRelaunch);

  // Linux webview UA 含 "Linux"（macOS/Windows 分别含 Mac/Win）
  const isLinux = typeof navigator !== 'undefined' && /Linux/.test(navigator.userAgent);
  const openWebsite = () => {
    const url = `${apiOrigin()}/`;
    invoke('sys_open_url', { url }).catch(() => window.open(url, '_blank'));
  };

  let statusText: string;
  if (checking) statusText = '正在检查更新…';
  else if (downloading) statusText = '正在下载更新…';
  else if (readyToInstall) statusText = `v${available?.version ?? ''} 已下载完成，重启应用后生效`;
  else if (available) statusText = `发现新版本 v${available.version}`;
  else if (upToDate) statusText = `已是最新版本（v${pkg.version}）`;
  else statusText = `当前版本 v${pkg.version}`;

  let action = (
    <Button size="small" loading={checking} onClick={() => void manualCheck()}>
      检查更新
    </Button>
  );
  if (error && !checking) {
    action = (
      <Button variant="secondary" size="small" onClick={() => void manualCheck()}>
        重试检查
      </Button>
    );
  }
  if (available && !downloading && !readyToInstall) {
    action = (
      <Button size="small" onClick={() => void download()}>
        下载更新
      </Button>
    );
  }
  if (downloading) {
    action = (
      <Button variant="secondary" size="small" disabled>
        下载中…
      </Button>
    );
  }
  if (readyToInstall) {
    action = (
      <Button size="small" onClick={() => void installAndRelaunch()}>
        重启并安装
      </Button>
    );
  }

  const percent =
    progress && progress.total ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : undefined;

  return (
    <Card size="small" title="软件更新" extra={action}>
      <Typography.Text type="secondary">{statusText}</Typography.Text>

      {downloading && progress ? (
        <Progress
          percent={percent}
          status={percent === undefined ? 'active' : undefined}
          format={() =>
            percent === undefined
              ? `${(progress.received / MB).toFixed(1)} MB`
              : `${(progress.received / MB).toFixed(1)} / ${((progress.total ?? 0) / MB).toFixed(1)} MB`
          }
          style={{ marginTop: 8 }}
        />
      ) : null}

      {available?.notes ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, whiteSpace: 'pre-wrap' }}>
          {available.notes}
        </Typography.Paragraph>
      ) : null}

      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 8 }}
          message={
            <>
              更新失败：{error}
              {isLinux ? (
                <div>
                  当前为 Linux 包安装（非 AppImage 不支持应用内自更新），请到
                  <Typography.Link onClick={openWebsite}>官网下载页</Typography.Link>
                  获取最新安装包。
                </div>
              ) : null}
            </>
          }
        />
      ) : null}
    </Card>
  );
}

export function AboutPage() {
  return (
    <div>
      <Typography.Title level={5} style={{ margin: 0, marginBottom: 16 }}>
        关于
      </Typography.Title>

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card size="small">
          <Flex vertical align="center" gap={4} style={{ padding: '8px 0', textAlign: 'center' }}>
            <Logo size={52} />
            <Typography.Title level={4} style={{ margin: '8px 0 0' }}>
              BaobaoWork
            </Typography.Title>
            <Typography.Text type="secondary">让协作更简单 · 企业协作工作台</Typography.Text>
            <Tag style={{ marginTop: 6 }}>v{pkg.version}</Tag>
          </Flex>
        </Card>

        <UpdateCard />

        <Card size="small" title="技术栈与文档">
          <List
            size="small"
            split
            dataSource={[
              { key: 'stack', name: '客户端技术栈', value: 'Tauri 2 · React 18 · antd 5 · Vite' },
              { key: 'design', name: '设计系统', value: 'D01 令牌体系 · 亮/暗双主题' },
            ]}
            renderItem={(row) => (
              <List.Item key={row.key}>
                <Flex justify="space-between" align="center" style={{ width: '100%' }}>
                  <span>{row.name}</span>
                  <Typography.Text type="secondary">{row.value}</Typography.Text>
                </Flex>
              </List.Item>
            )}
          />
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
            设计文档：概要 19 篇 + 详设 14 篇（docs/；doc/bot/rtc/meeting 篇目已随瘦身移除）
          </Typography.Text>
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
            基础件使用成熟开源软件（MIT/Apache-2.0），业务代码完全自研（附录 A 许可清单）
          </Typography.Paragraph>
        </Card>
      </Space>
    </div>
  );
}
