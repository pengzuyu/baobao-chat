// 把品牌资产（logo / 应用图标）从单源 brand/assets/ 同步到本站 public/
// 遵循 D31 品牌单源：换牌只改 brand/，本站不存副本（构建前自动覆盖）。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const here = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
const siteDir = resolve(here, '..');
const repoRoot = resolve(siteDir, '..');
const pub = resolve(siteDir, 'public');

const pairs = [
  ['brand/assets/logo.svg', 'logo.svg'],
  ['brand/assets/icon.png', 'icon.png'],
];

mkdirSync(pub, { recursive: true });
for (const [src, dst] of pairs) {
  const from = resolve(repoRoot, src);
  if (!existsSync(from)) {
    console.warn(`[sync-brand] 跳过（不存在）: ${src}`);
    continue;
  }
  copyFileSync(from, resolve(pub, dst));
  console.log(`[sync-brand] ${src} -> public/${dst}`);
}