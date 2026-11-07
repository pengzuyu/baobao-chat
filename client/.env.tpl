# =============================================================================
# BaobaoWork 客户端联调环境模板（cp .env.tpl .env.local && vim .env.local）
# -----------------------------------------------------------------------------
# · VITE_* 为 Vite 编译期注入：修改后需重启 dev server（tauri dev 会带起 vite）。
# · 客户端形态仅桌面端（2026-11-08 裁决）：本文件服务于 `npm run tauri dev`
#   桌面窗口联调与后续打包注入，不提供浏览器 Web 产品形态。
# · 三变量：VITE_API_BASE(REST) / VITE_WS_BASE(WS 信令) / VITE_USE_MOCK(桩开关)。
# =============================================================================

# —— mock 开关：置 0 走真实 API；不设或非 0 时所有页面跑桩数据（纯演示用）——
VITE_USE_MOCK=0

# —— 典型联调目标（按需启用其一，注释其余）——
# ① 本机 docker compose 部署（deploy/compose --profile core；nginx 443 自签证书
#    SAN 含 localhost——首次需把 deploy/compose/volumes/certs/ca.crt 导入系统
#    钥匙串并设为信任，否则 webview 内 fetch/wss 拒连）：
VITE_API_BASE=https://localhost/api/v1
VITE_WS_BASE=wss://localhost/ws/connect

# ② 本机裸跑服务端（make server-run，:8090）：
# VITE_API_BASE=http://127.0.0.1:8090/api/v1
# VITE_WS_BASE=ws://127.0.0.1:8090/ws/connect

# ③ 纯 mock 演示（不连服务端，变量可全注释——默认即 localhost:8080）：
# VITE_API_BASE=http://localhost:8080/api/v1
# VITE_WS_BASE=ws://localhost:8080/ws/connect
