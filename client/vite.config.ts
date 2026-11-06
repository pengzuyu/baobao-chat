import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite 配置：端口固定 5173 供 tauri.conf.json 的 devUrl 使用
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
