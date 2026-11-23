// BaobaoChat 公网官网（Astro 静态站）
// 部署时必须注入 SITE_URL（如 https://baobaochat.example.com），用于 canonical / sitemap / robots / JSON-LD。
// 未注入时仍可构建（便于本地预览），但不生成 sitemap。
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

const SITE_URL = process.env.SITE_URL?.trim().replace(/\/+$/, '') || undefined;

export default defineConfig({
  site: SITE_URL,
  integrations: SITE_URL ? [sitemap()] : [],
  build: {
    format: 'directory',
  },
  compressHTML: true,
});