/**
 * 设置 · 关于（D01 §4.2）：版本、更新、技术栈与设计文档索引。
 * 版本号取 package.json（scripts/release/set-version.sh 与 tauri.conf.json 等四处对齐）。
 * 更新区块（D21）：检查更新 → 下载（进度）→ 重启安装（plugin-process relaunch）；
 * Linux deb/rpm 装机（非 AppImage）不支持应用内自更新——出错时给官网下载引导。
 */

import { Button, Progress } from 'antd';
import { invoke } from '@tauri-apps/api/core';
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
    <Button size="small" type="primary" loading={checking} onClick={() => void manualCheck()}>
      检查更新
    </Button>
  );
  if (error && !checking) {
    action = (
      <Button size="small" onClick={() => void manualCheck()}>
        重试检查
      </Button>
    );
  }
  if (available && !downloading && !readyToInstall) {
    action = (
      <Button size="small" type="primary" onClick={() => void download()}>
        下载更新
      </Button>
    );
  }
  if (downloading) {
    action = (
      <Button size="small" disabled>
        下载中…
      </Button>
    );
  }
  if (readyToInstall) {
    action = (
      <Button size="small" type="primary" onClick={() => void installAndRelaunch()}>
        重启并安装
      </Button>
    );
  }

  const percent =
    progress && progress.total ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : undefined;

  return (
    <div className="settings-card about-update">
      <div className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__name">软件更新</div>
          <div className="settings-row__desc">{statusText}</div>
        </div>
        {action}
      </div>

      {downloading && progress ? (
        <div className="about-update__progress">
          <Progress
            percent={percent}
            status={percent === undefined ? 'active' : undefined}
            format={() =>
              percent === undefined
                ? `${(progress.received / MB).toFixed(1)} MB`
                : `${(progress.received / MB).toFixed(1)} / ${((progress.total ?? 0) / MB).toFixed(1)} MB`
            }
          />
        </div>
      ) : null}

      {available?.notes ? <div className="about-update__notes">{available.notes}</div> : null}

      {error ? (
        <div className="about-update__error">
          更新失败：{error}
          {isLinux ? (
            <div className="about-update__guide">
              当前为 Linux 包安装（非 AppImage 不支持应用内自更新），请到
              <button type="button" onClick={openWebsite}>
                官网下载页
              </button>
              获取最新安装包。
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AboutPage() {
  return (
    <div className="settings-section">
      <h2 className="settings-section__title">关于</h2>

      <div className="about-card">
        <div className="about-card__brand">
          <Logo size={52} />
          <div className="about-card__name">BaobaoWork</div>
          <div className="about-card__slogan">让协作更简单 · 企业协作工作台</div>
          <span className="about-card__version">v{pkg.version}</span>
        </div>

        <UpdateCard />

        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__name">客户端技术栈</div>
            </div>
            <span className="settings-row__value">Tauri 2 · React 18 · antd 5 · Vite</span>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__name">设计系统</div>
            </div>
            <span className="settings-row__value">D01 令牌体系 · 亮/暗双主题</span>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__name">设计文档</div>
              <div className="settings-row__desc">概要 19 篇 + 详设 14 篇（docs/；doc/bot/rtc/meeting 篇目已随瘦身移除）</div>
            </div>
          </div>
        </div>

        <div className="about-card__license">基础件使用成熟开源软件（MIT/Apache-2.0），业务代码完全自研（附录 A 许可清单）</div>
      </div>
    </div>
  );
}
