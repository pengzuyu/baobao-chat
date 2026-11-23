/**
 * 发布信息数据源（D21）：运行时拉取同源 /update/release-info.json
 * （由 scripts/release/gen-manifest.mjs 生成、publish.sh 发布）——
 * 发新版官网自动跟进最新版本与下载直链，无需重建网站。
 * 拉取失败（未发布/更新源不可达）回落 null → 页面呈现「暂未发布」占位态。
 */

export interface DownloadItem {
  /** 平台键（darwin-x86_64 / darwin-aarch64 / linux-x86_64 / windows-x86_64） */
  platform: string;
  /** 展示名 */
  label: string;
  /** 文件名 */
  file: string;
  /** 下载直链（绝对地址） */
  url: string;
  /** 字节数 */
  size: number;
  sha256: string;
  /** 是否参与应用内自动更新（.app.tar.gz / .AppImage / -setup.exe 为 true） */
  autoUpdate: boolean;
}

export interface ReleaseEntry {
  version: string;
  date: string;
  notes: string;
  downloads: DownloadItem[];
}

export interface ReleaseInfo {
  version: string;
  date: string;
  notes: string;
  downloads: DownloadItem[];
  /** 历史版本（含最新，按版本倒序；旧清单无此字段时缺省） */
  releases?: ReleaseEntry[];
}

export async function loadReleaseInfo(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch('/update/release-info.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as ReleaseInfo;
    if (!data || typeof data.version !== 'string' || !Array.isArray(data.downloads)) return null;
    return data;
  } catch {
    return null;
  }
}

/** 人类可读大小（MB 保留一位） */
export function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 日期展示（2026-11-12） */
export function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

/** 按平台聚合下载项；过滤掉 updater 专用中间产物（.app.tar.gz——官网只给 .dmg/.exe 等安装形态） */
export interface PlatformGroup {
  key: string;
  title: string;
  hint: string;
  items: DownloadItem[];
  current: boolean;
}

export function groupDownloads(info: ReleaseInfo): PlatformGroup[] {
  const visible = info.downloads.filter((d) => !d.file.endsWith('.app.tar.gz'));
  const by = (key: string) => visible.filter((d) => d.platform === key);
  const groups: PlatformGroup[] = [
    {
      key: 'darwin-aarch64',
      title: 'macOS · Apple 芯片',
      hint: 'M 系列 Mac 原生包。首次安装如提示无法验证开发者：右键安装包 →「打开」。',
      items: by('darwin-aarch64'),
      current: isPlatform('mac-arm'),
    },
    {
      key: 'darwin-x86_64',
      title: 'macOS · Intel 芯片',
      hint: 'Intel Mac 原生包（Apple 芯片机器可经 Rosetta 运行）。',
      items: by('darwin-x86_64'),
      current: isPlatform('mac-x64'),
    },
    {
      key: 'linux-x86_64',
      title: 'Linux · x86_64',
      hint: 'AppImage 支持应用内自动更新；deb 需手动到官网重新下载升级。',
      items: by('linux-x86_64'),
      current: isPlatform('linux'),
    },
    {
      key: 'windows-x86_64',
      title: 'Windows · x64',
      hint: 'NSIS 安装器，支持应用内自动更新（passive 静默装）。',
      items: by('windows-x86_64'),
      current: isPlatform('win'),
    },
  ];
  return groups;
}

/** 粗粒度平台识别（高亮「推荐下载」；识别不了全部不高亮） */
function isPlatform(kind: 'mac-arm' | 'mac-x64' | 'linux' | 'win'): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (!ua.includes('Mac OS')) {
    if (kind === 'linux') return ua.includes('Linux') && !ua.includes('Android');
    if (kind === 'win') return ua.includes('Windows');
    return false;
  }
  // macOS：Safari/WebKit UA 不暴露架构——Apple 芯片版优先（Intel 机器经 Rosetta 亦可运行）
  if (kind === 'mac-arm') return true;
  return false;
}
