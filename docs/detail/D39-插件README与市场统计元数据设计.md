# D39 · 插件市场 README 与统计元数据设计

> 2026-11-25 立稿。前置：D22（插件系统）/ D34（Markdown 富渲染）/ D38（统一身份）。
> 范围：插件包 README 说明 + 市场统计元数据（装机数/最近更新）。
> 不在范围：skill 旧接口（`/eco/skills`，SkillTab 已删无消费面）同款统计、
> 发布者署名展示（见 §10 开放问题）。

## 0. 背景与拍板决策

市场卡片与详情抽屉当前仅有单行 `description`（≤200 字校验），用户在安装前
无法了解插件用途、用法、风险细节；市场无任何统计信号（装机数/更新时间），
用户无从判断插件可信度与活跃度。`eco_plugin_install` 表逐用户一行
（ON CONFLICT 幂等），装机数据其实已在，只差聚合与透出。

拍板决策：

1. **README 属插件级元数据，随最新上传对齐**——与 name/description/category
   同组（`UpdatePluginMeta` 即时对齐口径），非版本级快照。理由：draft 自用
   沙盒（方案 A）上传即应可见；readme 是「插件的说明」不是「版本的说明」，
   无按版本差异消费的场景，版本行不存（manifest 存版本行是因为有
   「按版本下载+客户端对账」消费，readme 无此需求）。
2. **双位置识别，只认大写 `README.md`**：包根 `README.md` 优先 → 命中的
   清单目录内 `<dir>/README.md` 次之（`dir` 为三目录名识别实际命中的那个，
   非 `.bbc-plugin` 字面量）。兼容「顶层单目录 / 根即内容」两种打包形态，
   与清单识别同口径；生态惯例（npm / VS Code / Claude 插件）均大写。
3. **上限 64KB，超限拒绝**（对齐校验器「拒」风格——description>200 拒先例；
   不做截断，打包者自改）。UTF-8，CRLF 归一 LF（Windows 打包者友好）。
4. **readme 仅 detail 口返回**：`PluginDTO` 加 `readme` 字段但 catalog / mine /
   admin 列表构造不填——列表 payload 不背 64KB×N 的长文；repo 层
   `GetPluginReadme` 单查，`pluginCols` 读列不含（`Plugin.Readme` 仅写路径用，
   代码注释说明）。
5. **安装统计 = 当前装机数**：`COUNT(*) GROUP BY pkg_id`（每用户一行天然
   去重、卸载删行即减）。不做累计安装计数器——装机数对用户决策更有参考
   价值，且零迁移零维护成本；累计口径如未来有运营需求再立项。
6. **个人插件（owner>0）不展示装机数**：仅本人可见的市场显示「1 人安装」
   无意义；DTO 照填（顶多 1），前端按 `owner_user_id > 0` 隐藏。
7. **readme 远程图片一律拦截**（渲染为占位块）：防 beacon 追踪（安装意愿
   探测 / 用户 IP 泄露给第三方）；未安装浏览详情时也无本地文件可引用。
   文本链接保留（跟随 D34 现有行为）。
8. **管理端 v0 只加装机数列**，不做 readme 预览（治理看元数据与版本线足够，
   readme 是用户侧说明文档）。
9. **`updated_at` 顺带透出**（最近更新是市场标配；列已有、DTO 未带，纯补漏）。

## 1. 包格式变更（D22 §1.1 增补）

```
deploy-helper/
├── README.md                  # ★新增：插件说明（≤64KB，Markdown）——安装前详情页渲染
├── .bbc-plugin/plugin.json    # 清单（识别顺序：.bbc-plugin → .claude-plugin → .zcode-plugin）
├── skills/deploy/SKILL.md
├── commands/release.md
├── agents/release-verify.md
├── .mcp.json
├── hooks/hooks.json
└── server.js
```

- README.md **可选**：缺失不报错（详情页无「说明」区块，description 仍在）；
  存在但 >64KB → 发布校验拒绝。
- README.md **不进组件清单**（`componentFiles`）——它不是组件，不参与
  客户端复跑对照（`plugins.ts` `findManifest` 对账只核 name/version，
  readme 不影响装配安全，零改动）。
- README.md 内容不进 `PluginManifest` 快照（快照是版本级发布定格，
  readme 是插件级即时元数据——决策 1）。

## 2. 数据模型（迁移 `0006_plugin_readme.sql`）

```sql
-- 插件说明（插件级元数据，随最新上传对齐；64KB 上限由服务端校验器兜底）
ALTER TABLE public.eco_plugin ADD COLUMN readme text DEFAULT '' NOT NULL;

-- 装机数聚合查询辅助索引（COUNT(*) GROUP BY pkg_id；行数=用户×插件，万级，索引便宜）
CREATE INDEX idx_eco_plugin_install_pkg ON public.eco_plugin_install (tenant_id, pkg_id);
```

存量插件 readme 为空串（详情页无「说明」区块，向后兼容）。

## 3. 发布校验器变更（`plugin_validate.go`）

### 3.1 返回值重构

现签名 `validatePluginPackage(pkg []byte) (*PluginManifest, []string, error)`
返回值扩为结果结构（readme 独立于 manifest 快照——决策 1/4）：

```go
type pluginValidateResult struct {
    Manifest       *PluginManifest
    ComponentFiles []string
    Readme         string // 提取的 README.md 内容（CRLF→LF 归一；空=无）
}
```

### 3.2 提取规则

清单识别循环（`for _, dir := range manifestDirs`）记录命中的 `manifestDir`，
readme 按序探测（`join` 复用现有 base 前缀函数）：

1. `join("README.md")` —— 包根（或顶层单目录根，随 base）
2. `join(manifestDir + "/README.md")` —— 清单目录内

命中即读；两个位置都有时根优先（避免歧义）。校验：

- `len(data) > 64<<10` → 拒：「README.md 超限（>64KB）」
- 空/纯空白文件 → 视为无 readme
- `strings.ReplaceAll(data, "\r\n", "\n")` 归一

## 4. 服务端变更（`eco/` 域）

### 4.1 repo 层（`PluginRepo` 接口 + memory/PG 双实现）

```go
// 装机数聚合（tenant 内全量 GROUP BY，内存拼装——catalog 本就是全量拉+内存过滤风格）
CountPluginInstalls(ctx, tenantID) (map[int64]int64, error)
// detail 单查 readme（pluginCols 读列不含，见决策 4）
GetPluginReadme(ctx, tenantID, id) (string, error)
```

- `ecorepo.Plugin` struct 加 `Readme string` 字段（**仅写路径使用**：
  `InsertPlugin` 带入；`pluginCols` 读列不含，读路径该字段恒空——注释明示）。
- `InsertPlugin`：INSERT 列加 readme。
- `UpdatePluginMeta` 签名加 `readme string` 参数，沿现有「空串不覆盖」语义
  （管理面 `PluginMetaReq` 不含 readme，service 调用时传空=不动——兼容）。

### 4.2 service 层（`plugin.go`）

- `PluginDTO` 加字段：

```go
Readme     string `json:"readme,omitempty"` // 仅 detail 口填充（决策 4）
Installs   int    `json:"installs"`         // 当前装机人数（决策 5）
UpdatedAt  int64  `json:"updated_at"`        // 最近更新（列已有纯透出）
```

- `uploadPluginAs`：`validatePluginPackage` 换新结果结构；Insert / UpdateMeta
  带 readme。
- `PluginCatalog` / `MyPlugins`：开头一次 `CountPluginInstalls`，循环内拼
  `dto.Installs`（个人插件照填，前端隐藏——决策 6）。
- `PluginDetail`：`GetPluginReadme` 单查填 `e.Readme`。
- `ListPluginsAdmin`：同 catalog 拼装机数（管理端治理视角）。

## 5. 前端变更

### 5.1 API 层（`plugins.ts`）

- `PluginEntry` 加 `installs: number` / `readme?: string` / `updated_at: number`；
  mock 两分支同步补字段演示新形态。
- 落盘链（`installLocal` 复跑校验）**零改动**——readme 不参与对账（§1）。

### 5.2 市场卡片（`PluginPage.tsx`）

meta 行（`{plugin_id} · v{版本}`）追加装机数：

```
deploy-helper · v1.2.0 · 12 人安装（公共插件）
kb-boost · v0.3.0（个人插件不显示装机数）
```

### 5.3 详情抽屉

description 段后新增「说明」区块（`MarkdownText` 渲染 readme；有才渲染），
meta 行补「最近更新 YYYY-MM-DD」。抽屉宽度 480 不变（readme 富文本
（表格/代码块）按现有 `.agent-md` 样式自适应）。

### 5.4 渲染安全（`MarkdownText` 增强）

- `MarkdownText` 加 prop `blockRemoteImages?: boolean`（默认 false——
  D18/D24/agent 流零影响），透传 `renderInline`：img 分支受控后渲染占位块
  （灰框 + 「图片已屏蔽」文案）而非 `<img src>`。
- 插件 readme 调用点传 `blockRemoteImages`（决策 7）。
- 文本链接跟随 mdInline 现有 `<a target="_blank">` 行为（登记不修，
  见 §10）。

## 6. 管理端（`PluginGovernancePage.tsx`）

列表加「装机数」列（治理信号：哪些插件没人用）。readme 预览不做（决策 8）。

## 7. 边界与安全

- readme 渲染走 D34 自研渲染器（React 元素直出无 v-html，零 XSS 面），
  无 raw HTML 通道——readme 无额外注入面。
- 远程图片拦截 = 防 beacon（决策 7）；文本链接保留（链接点击不回拨
  服务器 IP 之外的指纹信息，且用户主动点击属明确意图）。
- readme 在服务端校验器提取（发布第一道），客户端不复跑（不装也能看
  详情——detail API 本就在可见性闸门内）。
- 64KB 上限服务端兜底；detail 响应体积上界 = 64KB + 元数据，可接受。
- 装机数不泄露个人信息（聚合计数，无按用户明细出口）。

## 8. 实施批次（每项一提交一推送）

- **批1 服务端全链**：迁移 0006 → repo（列/聚合/签名扩展 + memory 双实现）→
  校验器（结果结构 + README 提取）→ service（DTO/拼装/detail 单查）→
  Go 测试（双位置识别 / 64KB 拒 / 聚合口径：装→+1 卸→-1 同用户重复装=1 /
  UpdateMeta 空 readme 不覆盖）。
- **批2 前端 + 管理端 + 文档**：plugins.ts（DTO/mock）→ PluginPage（卡片
  meta / 抽屉说明区块）→ MarkdownText `blockRemoteImages` → 管理端装机数列
  → D22 §1.1 包结构示例补 README.md 行 + 文末指引「详见 D39」→
  tsc + vite build 绿。

## 9. 验收清单（真机走查）

1. 打带 README.md（根位置）的插件包上传 → 详情抽屉出现「说明」区块且
   Markdown 渲染正常（代码块/表格/列表）。
2. 清单目录内 README.md（次选位置）同样识别；两处并存时根优先。
3. README.md >64KB 上传被拒，报错文案含上限。
4. 安装 → 卡片装机数 +1；卸载 → -1；同账号重装不重复计数。
5. 个人插件卡片不显示装机数；公共插件显示「N 人安装」。
6. readme 内远程图片显示占位块（无网络请求——DevTools Network 验证）；
   文本链接可点。
7. 详情抽屉显示「最近更新」日期；市场卡片版本行正常。
8. 管理端插件列表出现装机数列。
9. 无 README.md 的存量插件详情无「说明」区块、description 正常展示（向后兼容）。

## 10. 开放问题登记

1. **发布者署名展示**：`created_by` 列已有，但映射用户名需跨 eco/users 域
   join——涉及域边界，另立项（市场「作者」是标配，优先级中）。
2. **readme 内相对路径图片**：已安装插件的包内图片理论上可从本地落盘目录
   引用（`PLUGIN_ROOT`），需要渲染层做 src 重写——v0.1 不做（远程拦截统一
   占位），需求真实出现再议。
3. **市场热度排序**：现排序 = force 置顶 + 名称稳定序；按装机数排序可作
   后续增强（数据已就绪，纯排序改动）。
4. **`<a target="_blank">` 桌面端行为**：WebView 内新开标签行为依赖宿主
   （可能静默无效）——D24 既有边界，非本篇引入，登记沿用。
