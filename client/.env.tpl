# =============================================================================
# BaobaoWork 客户端联调环境模板（cp .env.tpl .env.local && vim .env.local）
# -----------------------------------------------------------------------------
# · VITE_* 为 Vite 编译期注入：修改后需重启 dev server（tauri dev 会带起 vite）。
# · 客户端形态仅桌面端（2026-11-08 裁决）：本文件服务于 `npm run tauri dev`
#   桌面窗口联调与后续打包注入，不提供浏览器 Web 产品形态。
# · VITE_API_BASE(REST，唯一必配) / VITE_USE_MOCK(桩开关)。
# · VITE_WS_BASE 已可选（2026-11-09 同源推导）：默认由 VITE_API_BASE 推导
#   （去 /api/v1 → http(s)→ws(s) → 拼 /ws/connect；统一入口路径分流，16 篇）。
#   仅当 WS 走独立域名/端口时才需显式配置覆盖。
# · 正式出包不走本文件：scripts/release/build-desktop.sh 依 BBW_PUBLIC_URL 生成
#   临时 .env.production（v0.1 统一 http，D21），构建完即清理。
# =============================================================================

# —— mock 开关（D18 翻转后默认连真实 API）：仅纯前端演示时显式置 1 跑桩数据 ——
# VITE_USE_MOCK=1

# —— 典型联调目标（按需启用其一，注释其余）——
# ① 本机 docker compose 部署（deploy/compose --profile core；nginx 443 自签证书
#    SAN 含 localhost——首次需把 deploy/compose/volumes/certs/ca.crt 导入系统
#    钥匙串并设为信任，否则 webview 内 fetch/wss 拒连）：
VITE_API_BASE=https://localhost/api/v1

# ② 本机裸跑服务端（make server-run，:8090）：
# VITE_API_BASE=http://127.0.0.1:8090/api/v1

# ③ 纯 mock 演示（不连服务端：显式 VITE_USE_MOCK=1，API 变量可全注释）：
# VITE_API_BASE=http://localhost:8080/api/v1
