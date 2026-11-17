# =============================================================================
# BaobaoChat frp 实验台环境配置（cp .env.tpl .env 后填写；.env 不入 git）
# =============================================================================

# JWT 签名密钥：≥32 字节（服务端启动强校验）。生成：openssl rand -hex 32   ★必填
BBC_JWT_SECRET=

# CORS 放行源（逗号分隔）。默认覆盖 vite dev(5173) 与 tauri 生产壳两种 origin
# （Windows WebView2: http://tauri.localhost；macOS: tauri://localhost）
BBC_CORS_ORIGINS=http://localhost:5173,http://tauri.localhost,tauri://localhost
