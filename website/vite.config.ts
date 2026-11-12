import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 官网静态站（D21）：同源部署在 https?://<部署域名>/ 下——默认 base '/'
// 下载区数据运行时 fetch /update/release-info.json（发新版官网自动跟进，无需重建）
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
