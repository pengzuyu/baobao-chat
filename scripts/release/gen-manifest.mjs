#!/usr/bin/env node
// =============================================================================
// gen-manifest.mjs —— 发布清单生成（D21）
//
// 扫描 out/release/v<ver>/<platform>/ 产物目录，生成两份清单（写入同目录）：
//   latest.json      Tauri updater 标准清单（platforms 四键 + signature 读 .sig）
//   release-info.json 官网下载区数据源（版本/日期/更新说明/各平台直链/大小/sha256，
//                     含 .dmg/.deb 等不参与应用内自更新的直链包）
//
// 用法（BBC_PUBLIC_URL 必填，产出 URL 绝对地址）：
//   BBC_PUBLIC_URL=http://bbc.example.internal node scripts/release/gen-manifest.mjs \
//     [--version 0.2.0] [--notes "本次更新说明"] [--notes-file out/release/v0.2.0/RELEASE-NOTES.md]
//
// 布局约定（build-desktop 收集产物 → publish.sh 原样 rsync）：
//   out/release/v<ver>/darwin-x86_64/BaobaoChat.app.tar.gz(+.sig) + *.dmg
//   out/release/v<ver>/darwin-aarch64/…（同名 app.tar.gz——按平台子目录隔离防撞名）
//   out/release/v<ver>/linux-x86_64/*.AppImage(+.sig) + *.deb
//   out/release/v<ver>/windows-x86_64/*-setup.exe(+.sig)
// 服务器 URL 形如 <BBC_PUBLIC_URL>/update/releases/v<ver>/<platform>/<file>
// =============================================================================

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 参数 ──
const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const BASE = (process.env.BBC_PUBLIC_URL || '').replace(/\/+$/, '');
// 用 fileURLToPath 而非 URL.pathname：Windows 上 pathname 形如 /D:/a/...，
// resolve 会拼成 D:\D:\a\...（同 scripts/brand/gen.mjs 的坑）
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VER = argOf('--version') || JSON.parse(readFileSync(resolve(ROOT, 'client/src-tauri/tauri.conf.json'), 'utf8')).version;
const notesFile =
  argOf('--notes-file') || resolve(ROOT, `out/release/v${VER}/RELEASE-NOTES.md`);
const NOTES = argOf('--notes') ?? (existsSync(notesFile) ? readFileSync(notesFile, 'utf8').trim() : '');

if (!/^https?:\/\/[^/]+$/.test(BASE)) {
  console.error('[gen-manifest] BBC_PUBLIC_URL 必填且形如 http://bbc.example.internal（不带路径）');
  process.exit(1);
}

// ── 平台规格：updater 产物匹配器（每平台恰好一个 + .sig）──
const PLATFORMS = [
  { key: 'darwin-x86_64', label: 'macOS（Intel 芯片）', updaterRe: /\.app\.tar\.gz$/ },
  { key: 'darwin-aarch64', label: 'macOS（Apple 芯片）', updaterRe: /\.app\.tar\.gz$/ },
  { key: 'linux-x86_64', label: 'Linux（AppImage · 支持应用内更新）', updaterRe: /\.AppImage$/ },
  { key: 'windows-x86_64', label: 'Windows', updaterRe: /-setup\.exe$/ },
];

const OUT = resolve(ROOT, `out/release/v${VER}`);
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const urlOf = (plat, file) =>
  `${BASE}/update/releases/v${VER}/${plat}/${encodeURIComponent(file)}`;

const platforms = {};
const downloads = [];
let found = 0;

for (const p of PLATFORMS) {
  const dir = resolve(OUT, p.key);
  if (!existsSync(dir)) {
    console.warn(`[gen-manifest] ⚠ 缺平台产物目录 ${p.key}（该平台不进清单）`);
    continue;
  }
  const files = readdirSync(dir).filter((f) => statSync(resolve(dir, f)).isFile());
  const updaterFiles = files.filter((f) => p.updaterRe.test(f));

  if (updaterFiles.length === 1) {
    const f = updaterFiles[0];
    const sigPath = resolve(dir, `${f}.sig`);
    if (!existsSync(sigPath)) {
      console.warn(`[gen-manifest] ⚠ ${p.key}/${f} 缺 .sig（未签名的试包？该平台不进清单）`);
    } else {
      platforms[p.key] = {
        signature: readFileSync(sigPath, 'utf8').trim(),
        url: urlOf(p.key, f),
      };
      found += 1;
    }
  } else if (updaterFiles.length > 1) {
    console.warn(`[gen-manifest] ⚠ ${p.key} 匹配到多个 updater 产物（${updaterFiles.join(', ')}），跳过该平台`);
  }

  // 全部文件进官网直链清单（.sig 不露出）
  for (const f of files.filter((x) => !x.endsWith('.sig'))) {
    downloads.push({
      platform: p.key,
      label: p.label,
      file: f,
      url: urlOf(p.key, f),
      size: statSync(resolve(dir, f)).size,
      sha256: sha256(resolve(dir, f)),
      autoUpdate: updaterFiles.includes(f),
    });
  }
}

if (found === 0) {
  console.error('[gen-manifest] 无任何带签名产物——先在各平台跑 build-desktop（含 TAURI_SIGNING_PRIVATE_KEY）');
  process.exit(1);
}

const pubDate = new Date().toISOString();
const latest = { version: VER, notes: NOTES, pub_date: pubDate, platforms };
const releaseInfo = { version: VER, date: pubDate, notes: NOTES, downloads };

writeFileSync(resolve(OUT, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
writeFileSync(resolve(OUT, 'release-info.json'), `${JSON.stringify(releaseInfo, null, 2)}\n`);

console.log(`[gen-manifest] v${VER}：updater 平台 ${found}/${PLATFORMS.length}，官网直链 ${downloads.length} 个`);
console.log(`[gen-manifest] 已写 ${resolve(OUT, 'latest.json')} 与 release-info.json`);
if (found < PLATFORMS.length) {
  console.warn('[gen-manifest] ⚠ 非全量清单——publish.sh 默认拒发（BBC_ALLOW_PARTIAL=1 放行）');
}
