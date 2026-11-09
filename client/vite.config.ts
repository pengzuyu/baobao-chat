import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite 配置：端口固定 5173 供 tauri.conf.json 的 devUrl 使用；
// 双入口：主应用 index.html + 独立会议窗口 meeting.html（D17 §4）
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // 拆分大依赖，避免单 chunk 超 500kB 告警
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        meeting: resolve(__dirname, 'meeting.html'),
      },
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          antd: ['antd'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
});
