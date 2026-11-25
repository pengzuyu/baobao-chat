# D26 个人 MCP 接入面设计（D16 P1-5 补账 + bbrt TLS）

- 日期：2026-11-13 ｜ 状态：设计定稿（本轮拍板），批次开工
- 前置：D16 §6 P1-5（个人 MCP 配置面挂账项）、D22（插件 MCP 装配链/三变量族/钥匙串分流）、D11（bbrt 内部设计）
- 动机：对齐 zcode 的用户自配 MCP 机制——用户在客户端设置页登记自己的 MCP server（stdio 命令 / HTTP(S) 端点），工具以 `mcp.{name}.*` 并入 agent 会话。现状工具只有两个来源：插件携带的 `.mcp.json` 与写死的 corp 网关，**没有用户自助入口**。顺带补 bbrt 手写 HTTP/1.1 的 https/TLS 缺口（公网 MCP server 基本只有 https，不补则个人面只能连内网 http:// 或本机 stdio）。

## 0. 拍板点（2026-11-13 会话裁决，勿重提）

| # | 决策 | 内容 |
|---|------|------|
| 1 | 范围 | **仅个人自配面**（仅本人会话生效）；管理端公共 MCP 下发不做（→OQ-1） |
| 2 | TLS | **本次一并补**：bbrt-mcp 引 rustls（ring 后端）+ webpki-roots，手写 HTTP/1.1 加 TLS 层；SSE/streamable 仍不做（→OQ-2） |
| 3 | 存储 | **纯客户端本地**：personal.json + 钥匙串真值，真值不经服务端——与插件 config 同制（D22 §6.1/L4） |
| 4 | 优先级 | corp > 插件 > 个人，同名跳过+告警（D22 防劫持口径顺延）；`corp` 为保留名 |
| 5 | 变量族 | 复用 D22 §6.1 子集：`${BBC_USER_ID}`/`${BBC_USER_NAME}` 装配静态替换；`${BBC_USER_TOKEN}` HTTP headers 留 RT 调用层动态替换、stdio env 置空（HTTP-only 约定不变）；个人面**无** `${PLUGIN_ROOT}`/`${CONFIG:*}` |
| 6 | 测试连接 | **走 RT 真实链路**：协议 `McpTest`/`McpTestResult`，一次性 McpClient 即弃——TLS、TOKEN 动态注入、懒连接全走生产代码，测的就是真实路径 |

> **★追记（2026-11-24，D38 落稿）**：个人面 HTTP server 新增鉴权方式「统一身份」（`x-bbc-auth {type:obo, scope?}`，aud=该 server url，agent 票 ES256——详见 [D38](D38-统一身份票据与生态MCP验签设计.md)），与「自定义请求头」（`${CONFIG:key}`/钥匙串）并列二选一；headers `${BBC_USER_TOKEN}` 旧写法装配器自动归一。url 用户可自填任意 `http(s)://`（个人面风险归属用户自身，声明统一身份时确认弹窗明示目的地）；stdio 一律无令牌（拍板：管道内无验证方）。

## 1. 范围与不做

**做**：设置页「MCP 服务」；壳侧五命令；`assemble_mcp_servers` 第三源；bbrt-mcp https；测试连接链路。

**不做**（→§10 开放问题）：管理端公共下发、SSE/streamable HTTP、工具注册表热重建（新 server 需重启会话才进模型 tools 列表——**沿用插件口径**，UI 同 PluginPage 提示）、跨设备同步、ToolCard `mcp.*` 名美化。

## 2. 数据模型（客户端本地，零服务端参与）

文件 `{dataDir}/eco/mcp/personal.json`（与 `eco/plugins`、`eco/experts`、`eco/skills` 同级）：

```json
{
  "servers": [
    {
      "name": "my-github",
      "enabled": true,
      "kind": "http",                      // "stdio" | "http"
      "url": "https://mcp.example.com/mcp",
      "headers": { "X-Api-Key": "" },      // secret 值文件存空串占位
      "secretKeys": ["X-Api-Key"],
      "note": "GitHub 仓库查询",
      "updatedAt": 1763000000
    },
    {
      "name": "local-tools",
      "enabled": true,
      "kind": "stdio",
      "command": "node",
      "args": ["/abs/path/server.mjs"],    // 个人面无 PLUGIN_ROOT，须绝对/可解析路径
      "env": { "API_TOKEN": "" },
      "secretKeys": ["API_TOKEN"],
      "updatedAt": 1763000000
    }
  ]
}
```

- **secret 分流**（镜像 `plugin_commands.rs` 的 config 制）：`secretKeys` 所列 env/header 键，真值入钥匙串 **service `com.baobaochat.mcp`、account `{server名}/{键名}`**；personal.json 只存 `""` 占位——secret 真值不落盘。读取时合并（同 `read_plugin_config` 的空串回查）。
- **校验**（upsert 时）：
  - name 同 Go `reMcpServerID`（`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`，plugin_validate.go:95——server 名即 `mcp.{name}.*` 命名空间段），保留名 `corp` 拒绝；
  - stdio 须非空 `command`；http 须 `http://` 或 `https://` 开头的 url；
  - **usesIdentity 探测**：任一 env/header 值含 `${BBC_USER_TOKEN}` → 列表回显该标记（UI 警示「将以你的身份调用」，同插件口径）。
- 删除 = 文件条目删除 + 该 server 全部钥匙串条目删除。

## 3. 壳命令层（`client/src-tauri/src/mcp_commands.rs` 新文件）

| 命令 | 语义 |
|------|------|
| `mcp_personal_list()` | 全量列表（secret 值恒回 `""`；附 usesIdentity） |
| `mcp_personal_upsert(server, secret_values)` | §2 校验 → secret 分流钥匙串 → 写文件 → **装配重推** |
| `mcp_personal_remove(name)` | 删条目+钥匙串 → 装配重推 |
| `mcp_personal_set_enabled(name, enabled)` | 翻启停 → 装配重推 |
| `mcp_test_connection(name)` | 按名取已保存条目（合并钥匙串）→ 组 wire → `host.request("mcp.test")` → 回 `{ok, tools, error}` |

- **装配重推**：复用既有全量推送链，`AgentHost::push_plugin_mcp` 改名 **`push_mcp_assembly`**（语义从「插件」扩为「三源全量装配」，调用点：plugin_commands.rs ×4 + spawn ready 兜底）——内部仍 `assemble_mcp_servers` → `mcp.config`（NTF）+ `tools.reload{reason:plugin}`。失败降级告警不阻断（同插件口径：重启会话后由 ready 重推兜底）。
- 命令注册进 `lib.rs` invoke_handler。

## 4. 装配与优先级（`agent_bridge.rs`）

`assemble_mcp_servers` 扩为**三源**：

1. **corp**（不变）：HTTP 网关，进程 env 兜底 + 装配覆盖；
2. **插件**（不变）：各启用插件 activeVersion 的 `.mcp.json`/内联 mcpServers；
3. **personal（新）**：读 `eco/mcp/personal.json`，跳过 `enabled=false`，env/header 合并钥匙串真值，逐条复用 `mcp_server_wire(name, def, /*plugin_root*/ "", &user, /*config*/ 空表)`——`${BBC_USER_ID/NAME}` 照常静态替换、headers 中 `${BBC_USER_TOKEN}` 照常保留给 RT、stdio env 置空，无 PLUGIN_ROOT/CONFIG 语义（个人面不使用）。

**同名冲突**：`taken` 表顺延——corp 先占、插件次之、**个人同名跳过**（eprintln 告警；UI 不预检，装配层防劫持兜底）。

## 5. bbrt-mcp：https/TLS（`agent/crates/bbrt-mcp`）

- **依赖**：`rustls = "0.23"`（`default-features = false`，features `["ring","std","tls12"]`——ring 后端避开 aws-lc-rs 的 cmake 构建链，纯 cargo 可编）+ `webpki-roots = "0.26"`（Mozilla 根证书集，免系统证书库依赖）。
- **http.rs 改造**（其余文件零感知）：
  - `ParsedUrl` 增 `scheme`（`http` 缺省 80 / `https` 缺省 443）；
  - 新 `connect_stream() -> Box<dyn ReadWrite>`：http=裸 `TcpStream`；https=`TcpStream::connect` + `rustls::ClientConnection`（`ServerName` 取 host 作 SNI，webpki 根校验）包 `StreamOwned`；
  - `post_json` / `get_text` 改用 `connect_stream`（读写/超时/1MB 上限/`Connection: close` 单请求单连接语义全不变）；
  - `parse_url` 对 https 由报错改为正常解析（错误文案「https 待网关 TLS」的开放问题就此销账）。
- **main.rs**：`parse_mcp_servers` 的 url 形态判断 `http://` 前缀扩为 `http(s)://`。
- bbrt-aigw 的手写 http 不动（网关内网 http 口径不变）。

## 6. 测试连接（协议 + RT）

- **envelope**（bbrt-protocol）：
  - `HostToRuntime::McpTest { server: McpServerWire }`（REQ）
  - `RuntimeToHost::McpTestResult { name: String, ok: bool, tools: Vec<String>, error: Option<String> }`（回执；tools 为短名清单）
- **main.rs handler**：`wire_to_mcp_config` 单条转换 → 一次性 `McpClient::connect(&[cfg], tokens)` + `list_tools`（空 PolicyFilter——测连通与工具发现，不套租户策略）→ 取首个 ConnectResults + 工具名 → drop 即断连。stdio 冷启动慢（node ~1s）由 request 侧超时兜底。
- **宿主**：复用 `AgentHost::request()`（reply_to 关联，agent_bridge.rs:506），msg_type `mcp.test`。

## 7. 前端（设置页）

- **路由/导航**：`/settings/mcp`，SettingsLayout tab「MCP 服务」（Plug 图标，Agent 后）；App.tsx 子路由注册。
- **`features/settings/api/mcp.ts`**：五命令 invoke 封装（`isTauriAvailable()` 守卫，非桌面端禁用编辑——同 plugins.ts）。
- **`features/settings/pages/McpSettingsPage.tsx`**：
  - 列表卡片：名称 / kind 徽章（stdio·HTTP / https 标注）/ 启停开关 / 编辑 / 删除（确认）/ **测试**按钮——成功回显「✓ N 个工具（名称截断列表）」，失败回显错误；
  - `usesIdentity` 警示条「将以你的身份调用」（同 PluginPage L265 口径）；
  - 编辑器：kind 二选一；stdio=command + args（每行一条）+ env 键值行；http=url + headers 键值行；**逐值「密文」checkbox** → 该键入 `secretKeys`（已存 secret 留空=不改，空串不覆盖钥匙串真值——同 plugin_write_config 语义）；
  - 顶部提示条：「新增/修改 server 后需重启会话，工具才会进入模型工具列表」（插件同口径）；
  - 变量族帮助文案：`${BBC_USER_TOKEN}`/`${BBC_USER_ID}`/`${BBC_USER_NAME}` 三行小表（含 TOKEN 仅 HTTP headers 可用、stdio env 置空约定）。
- **i18n**：`shared/i18n/index.ts` 中英词条（tab 名/页面/表单/错误）。

## 8. 分批提交（每批一提交一推送）

| 批 | 内容 | 验证 |
|----|------|------|
| 1 | 本文档 + detail/README 索引 | — |
| 2 | bbrt-mcp TLS（Cargo + http.rs + main.rs 前缀 + 测试） | `cargo test -p bbrt-mcp` |
| 3 | 协议 McpTest/McpTestResult + bbrt main.rs handler | `cargo build`（agent 工作区） |
| 4 | 壳侧 mcp_commands.rs 五命令 + 装配第三源 + push 改名 + lib.rs 注册 | `cargo build`（client/src-tauri） |
| 5 | 前端设置页 + api + 路由 + i18n | `tsc` 0 错 + `vite build` 绿 |

## 9. 真机验收清单

1. **stdio**：把 hello-baobao 的 `server.mjs` 以绝对路径登记为个人 server → 测试按钮回显 3 工具 → 重启会话后 `mcp.{name}.hello_time` 可在聊天页调用成功；
2. **http 内网**：连 :8090 类内网 HTTP MCP 端点连通；
3. **https 公网**：连任一公网 https MCP server 连通（TLS 握手+工具列表正常）；
4. **secret 不落盘**：personal.json 中 secret 值恒为 `""`，钥匙串 app 密码项可见真值；列表回读不泄漏；
5. **同名冲突**：登记与插件同名 server → 装配跳过且 bbrt.log 有告警，插件工具不受影响；
6. **TOKEN 动态**：headers 用 `${BBC_USER_TOKEN}` 的 server，登录态变化后无需重配即可用；
7. **启停/删除**：禁用即从 mcp.config 移除（已建会话内工具标灰），删除连钥匙串条目一起清；
8. **重启口径**：新增 server 后旧会话不出现其工具、新会话出现（注册表快照限制的正面确认）。

## 10. 开放问题

| OQ | 内容 | 备注 |
|----|------|------|
| OQ-1 | 管理端公共 MCP server 下发（zcode workspace 层对位） | 本期拍板不做；需服务端新表+管理页 |
| OQ-2 | SSE / streamable HTTP transport | 现单请求单连接 POST；长连接 server 不兼容 |
| OQ-3 | ~~工具注册表热重建（mcp.config 后免重启进模型 tools 列表）~~ **已收口（2026-11-25）**：PipelineExecutor.registry 改 RwLock + `reload_mcp()` 热重建，宿主 McpConfig 分支后台线程触发；新增 `list_plugins` 自省工具（来源/版本/连接态）与插件专家热重扫 | 已收口 |
| OQ-4 | 跨设备同步/服务端漫游 | KMS 加密存储候选；本期客户端本地 |
| OQ-5 | ToolCard `mcp.{server}.{tool}` 展示美化（server 徽章） | 现直渲染全名 |
| OQ-6 | 租户策略对个人 server 的治理入口 | 0028 `mcp.{server}` 通配已可禁用（RT PolicyFilter），管理 UI 未做 |
