# BaobaoWork 客户端（阶段一骨架）

Tauri 2 + React 18 + TypeScript（strict）+ Vite + Zustand + TanStack Query + AntD 5。
阶段一范围：应用壳（56px 导航 + 路由）/ 认证 / IM 三栏，六态与断点体系按 D01 落地。

## 目录结构（严格映射 D01 §12）

```
client/
├─ package.json                 # scripts: dev / build / preview / typecheck / tauri
├─ vite.config.ts / tsconfig.json / index.html
├─ src/
│  ├─ app/                      # 应用壳：路由（App.tsx）、三栏布局壳（MainLayout.tsx）、Provider
│  ├─ styles/tokens.css         # D01 §6 全量设计令牌（色/字/距/圆角/z-index/断点；暗色预留）
│  ├─ shared/
│  │  ├─ api/http.ts            # REST 封装：{code,data,trace_id} 解包、错误码→中文表、token 注入
│  │  ├─ api/ws.ts              # WS 客户端：信封/30s 心跳/指数退避重连/ack 配对/事件订阅
│  │  ├─ api/keys.ts            # Query key 工厂 + WS 推送精准失效映射
│  │  ├─ store/connection.ts    # 在线状态机 online/connecting/offline + 全局横幅
│  │  ├─ ui/                    # Button / Skeleton / Empty / StateView（六态统一组件）
│  │  ├─ bus/                   # 类型安全事件总线（features 经 declare module 扩充）
│  │  └─ utils/                 # useBreakpoint（四档断点）/ time
│  └─ features/
│     ├─ auth/                  # LoginPage（口令表单+1007 锁定倒计时）/ store（token 内存+静默刷新骨架）/ api
│     └─ im/                    # ChatPage 三栏 / ConversationList·MessageBubble·MessageInput·ChatHeader·ConvInfoSidebar
│        │                      # store/im.ts（会话/消息 + 乐观更新 sending→sent/failed）
│        │                      # api/（REST + msg.send + mock 集中桩）/ model/（D03 §6.3 类型）/ events.ts
└─ src-tauri/                   # Tauri 2 壳：Cargo.toml / tauri.conf.json / capabilities / main.rs+lib.rs
                                # IPC 命令示例：sys_open_url / http_get_stub / win_minimize
```

## 启动

```bash
npm install
npm run dev          # 浏览器开发（默认 mock 桩数据，无需后端）
npm run typecheck    # tsc --noEmit（strict）
npm run build        # vite 生产构建 → dist/
npm run preview      # 预览构建产物

# Tauri 桌面端（需 Rust 工具链，当前环境无 cargo 未验证）
npm run tauri dev
npm run tauri build
```

- mock 开关：默认开（`VITE_USE_MOCK` 未设或非 `0`）；连真实后端用 `VITE_USE_MOCK=0 npm run dev`。
- 环境变量（可选）：`VITE_API_BASE`（默认 `http://localhost:8080/api/v1`）、`VITE_WS_BASE`（默认 `ws://localhost:8080/ws/connect`）。
- mock 登录：任意账号口令；账号 `locked` 演示 1007 错误锁定倒计时。

## 与 D01 的映射（落点速查）

| D01 条目 | 落点 |
|---|---|
| §4 路由总表 | `src/app/App.tsx`（/auth、/im、/im/c/:convId、其余一级导航占位） |
| §4.1 左栏 56px 导航 | `src/app/MainLayout.tsx`（未读徽标 / admin 权限显隐 / 头像菜单） |
| §5.1 三栏模型 | `src/features/im/pages/ChatPage.tsx`（264 / flex:1 / 304） |
| §5.2 断点四档 | `shared/utils/useBreakpoint.ts` + `styles/global.css` media query（M 列表收窄 56、S 两级导航、L 详情浮层、XL 常驻） |
| §6 设计令牌 | `src/styles/tokens.css`（全量变量 + 暗色预留块） |
| §7 六态 | `shared/ui/StateView.tsx`（loading 防闪烁 300ms / empty / error+trace_id 复制 / offline 缓存+遮罩 / forbidden / degraded 黄条） |
| §7.7 乐观更新 | `features/im/store/im.ts` sendText/retrySend（sending 灰钟→sent ✓→failed ❗重试） |
| §12.2 依赖规则 | features 无横向 import（跨模块走 bus）；shared 不 import features（token 经 provider 注入） |
| §12.3 IPC 命令 | `src-tauri/src/lib.rs`（sys_open_url / http_get_stub / win_minimize，capabilities 白名单） |
| 14 篇协议 | `shared/api/http.ts`（响应包/错误码）、`shared/api/ws.ts`（信封/心跳/退避/ack 10s×3） |

## 遗留 TODO（阶段二+）

- 虚拟滚动（react-virtuoso）+ 未读锚点定位 + 上滚停随（INT-IM-08/13）
- msg.read/typing/receipt/reaction 通道；会话内搜索两态（PIM-07）
- outbox 持久化到 Rust SQLite；deviceId 由 Rust 生成；托盘/角标（win_set_badge）
- 群管理四 tab（PIM-05）、收藏/通知中心/多选转发（PIM-08~11）
- 暗色模式令牌映射与 AntD token 融合（D01 §14-2，UI 评审后冻结）
- eslint-boundaries 依赖规则 CI 校验；i18n 资源键（`域.页面.键`）
- Tauri 侧：WSS/REST 移交 Rust 核心持有；关闭按钮最小化到托盘；图标资源（src-tauri/icons）
