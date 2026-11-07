# 文档中心阶段一（D05 务实版）交付物

BaobaoWork 文档中心阶段一：**纯 markdown 原生文档**（无 WOPI/OnlyOffice）——doc_file/doc_version 两表 + 乐观锁保存（6004 版本冲突）+ 版本时间线/恢复 + 回收站（30 天保留/同名" (恢复)"后缀）+ 分享占位 + 客户端文档中心/编辑器/回收站三页 + IM `doc_card` 消息气泡简版。

设计依据：`docs/06-在线文档协作设计.md` · `docs/detail/D05-文档中心模块详细设计.md`（阶段一口径差异见文末取舍登记）。

## 一、REST（阶段一务实版 11 项；D05 §5.1 全表 32 项的裁剪）

前缀 `/api/v1/doc`，全部 owner 私有（scope 恒 personal；非 owner 一律 6001/6005，ACL 阶段二）。

| 路由 | 说明 | 关键错误码 |
|---|---|---|
| `GET /doc/files?q=&cursor=&limit=` | 列表+名称模糊（ILIKE）；键集翻页 cursor=`"<ms>-<id>"` | — |
| `POST /doc/files {title}` | 新建 markdown 文档（v1 空白，snapshot=create） | 6015 同名 / 9001 |
| `GET /doc/files/{id}` | 元数据+当前正文（content_md 冗余直读） | 6005 |
| `PATCH /doc/files/{id} {title}` | 重命名 | 6015 / 6005 |
| `DELETE /doc/files/{id}` | 移入回收站（status=2 + purge_at=now+30d） | 6005 |
| `PUT /doc/files/{id}/content {content_md, base_version}` | **乐观锁保存**：base_version≠current → 6004；成功 version+1 落 manual 快照+冗余正文回写 | 6004 / 6005 / 6007 |
| `GET /doc/files/{id}/versions?cursor=` | 版本时间线（version 倒序） | 6005 |
| `POST /doc/files/{id}/versions/{v}/restore` | 恢复（restore 快照新版本+正文回写，绝不覆盖） | 6013 / 6005 |
| `GET /doc/trash?cursor=` | 回收站列表（purge_at 升序；过期行不可见） | — |
| `POST /doc/trash/{id}/restore` | 恢复（同名冲突自动加" (恢复)"后缀） | 6011 |
| `POST /doc/files/{id}/share` | 分享占位：share_id+7d 过期+假 URL `bbw://doc/s/{id}`（不落库） | 6005 |

> **6001/6004 冲突码取舍**：任务书提到"6001 冲突码，查 codes.go/14 篇缺则补"。经查
> `codes.go` 与 14 篇 §7，6001=无编辑权限、**6004=版本冲突**（06 §7.1"PutFile 校验
> base_version 落后 → 拒绝 6004"为权威语义），且 6001-6015 十五码均已注册——故乐观锁
> 冲突采用 **6004**（无需补登记），6001 用于"非 owner 编辑他人文档"。客户端冲突红条
> 亦按 6004 分支。

代码位置：装配 `server/cmd/bbw-server/main.go`（仅追加：import + 装配块 + 11 条路由 + 文件尾 REST 壳）；域 `server/internal/doc/`（api/service/repo/module）。

## 二、表结构（migrations/0011_doc.sql，幂等 + RLS）

- **doc_file**：id/tenant_id/owner_id/title/folder_id(0=根)/scope(恒 personal)/status(1 正常 2 回收站)/purge_at/current_version/content_md(冗余当前正文)/created_at/updated_at。索引：(tenant,owner,status,updated_at DESC) 列表 + (tenant,owner,title) 同名判定。
- **doc_version**：id/tenant_id(RLS 载体)/doc_id/version/editor_id/snapshot_type(create|manual|restore)/content_md/created_at；**UK(doc_id, version)**。
- RLS：两表 `p_tenant` 策略（`tenant_id = app.tenant`，与 kb 域同口径）。
- ID 分配 advisory lock **9116(doc_file)/9117(doc_version)** + max+1（org 9101 · message 9102-9108 · file 9109 · kb 9110-9113 · admin 9114-9115 已占）。
- 并发写：PG `SELECT … FOR UPDATE` 行锁 + base_version 键校验（SaveContent/RestoreVersion 单事务）；内存实现同语义互斥锁。

## 三、E2E 验证（8090 内存模式 + 4173 preview，2026-11-07）

环境：`BBW_HTTP_ADDR=:8090 bbw-server`（内存存储+seed alice/bob）+ `VITE_USE_MOCK=0 VITE_API_BASE=http://127.0.0.1:8090/api/v1 npm run build && npx vite preview --port 4173`；浏览器双标签页均登录 alice。

| # | 步骤 | 结果 | 截图 |
|---|---|---|---|
| 1 | 文档中心：左树（最近打开/全部文档/回收站入口）+ 列表（标题/更新时间/版本徽标）+ 搜索「验收」模糊命中 2 篇（排除冒烟文档） | 列表/搜索/左树正常 | `01-doc-center-search.png` |
| 2 | 新建「E2E 验收文档」→ 进入编辑器 v1；填入 markdown → **Cmd/Ctrl+S 保存** | 底栏「已保存 v2」+ 标题徽标 v2 | `02-edit-saved-v2.png` |
| 3 | 再编辑（代码块/有序列表）→ 保存 v3 | 「已保存 v3」 | `03-edit-saved-v3.png` |
| 4 | 版本时间线抽屉 | 三版倒序：v3 手动(当前)/v2 手动/v1 创建 | `04-version-timeline.png` |
| 5 | 恢复 v2 | **新版本 v4（恢复徽标）+ 正文回写为 v2 内容**；时间线四版，v2/v3 原版本未被篡改 | `05-restored-v2-as-v4.png` |
| 6 | 预览切换 | MarkdownLite 渲染：h2/加粗/行内代码/引用块 | `06-markdown-preview.png` |
| 7 | **双 tab 同 base_version**：tab B 持 v4 基线，tab A 先保存 → v5；tab B 再保存 | **6004 冲突红条**（基线落后提示 + 强制覆盖/加载最新两出路） | `07-conflict-6004-redbar.png` |
| 8 | tab B 点「强制覆盖」（重取最新基线再存本端内容） | 「已保存 v6」，正文为 tab B 内容 | `08-force-overwrite-v6.png` |
| 9 | 移入回收站 → 新建同名文档 → 回收站页 | 回收站列表含 v6 条目、剩余 30 天 | `09-trash-list.png` |
| 10 | 回收站恢复 | toast「已恢复（同名冲突，新名《E2E 验收文档 (恢复)》）」；列表双文档并存、回收站清空 | `10-restored-with-suffix.png` |
| 11 | 编辑器「发卡片」→ alice-bob 会话 → /im | **doc_card 气泡**（标题+v6+点击打开）；点击 → `/doc/2` 编辑器 | `11-im-doc-card.png` |
| 12 | 分享按钮 | 占位弹窗：share_id + `bbw://doc/s/fc73…` + 7d 有效期 | `12-share-placeholder.png` |

附带验证（DOM 断言）：重命名同名 → 内联红字「同名文档已存在」（6015）；`getErrorText` 补 6004/6007/6011/6013/6015 中文文案；最近打开 LRU（localStorage）随打开/改名/删除同步；服务层单测另覆盖非 owner 6001、过期回收站 6011、目标版本 6013、不存在 6005、翻页不重不漏。

自动化口径备注：IAB 自动化浏览器的 `press()` 不传递修饰键/回车（Cmd+S、Enter 需以真实 `KeyboardEvent` 派发验证——快捷键链路本身全绿，截图 02/03 即该链路产物）；token 内存态（D01 §12.2-5）故整页刷新即登出，E2E 全程站内导航。

## 四、阶段一取舍登记（与 06/D05 全量设计的差异，逐条）

| # | 项 | 阶段一口径 | 全量设计（06/D05）出处 |
|---|---|---|---|
| 1 | 文档形态 | **只做 markdown 原生文档**：textarea 编辑+简版渲染预览；WOPI/OnlyOffice 集成、Word/Excel/PPT、OOXML、预览 PDF 转换管线（LibreOffice）全部不做 | 06 §4.1/§4.6、D05 §3.3/§3.8 |
| 2 | 表 | 九表裁二：doc_file/doc_version 落地；doc_folder（K1 文件夹树）/doc_permission（ACL 投影）/doc_session/doc_share/doc_template/doc_trash（事件表）/doc_access_req 不建（回收站以 status+purge_at 就地承载；doc_version 追加 tenant_id 作 RLS 载体） | 06 §5、D05 §6.1 |
| 3 | scope/权限 | 恒 personal 即全 owner 私有；四档 perm/ACL 授权/权限申请与审批/转发授权提示不做；6001 用于非 owner 防御 | 06 §4.4、D05 §3.9/§3.10 |
| 4 | 会话/协作 | 无编辑会话（doc_session/token 滚动/心跳/孤儿回收）、无 presence 协作头像、无水印、无 @提及；并发以**乐观锁 6004+强制覆盖**收敛（06 §7.1 markdown 版） | 06 §4.2/§4.3、D05 §4.2 |
| 5 | 版本 | snapshot_type 三态 create/manual/restore；auto(5min)/close/import 快照、版本对比（diff）、版本下载票据不做 | 06 §4.5、D05 §3.6 |
| 6 | 分享 | 一次性 share_id（96bit 随机）+7d+假 URL `bbw://doc/s/…`，**不落库**、无密码/禁止下载/撤销/链接列表/外链解析页 | 06 §4.4、D05 §3.5 |
| 7 | 回收站 | 软删+30 天保留（租户 7-90 可配不做）；恢复同名加" (恢复)"后缀；**到期物理清除定时任务不做**（列表侧按 purge_at 过期过滤即"已删除"口径）；彻底删除/清空（doc:trash:purge）不做 | 06 §4.7、D05 §3.7 |
| 8 | 模板库 | 不做（新建仅空白 markdown，无 type/template_id 入参） | 06 §4.7、D05 §3.4 |
| 9 | 聊天文件转协作文档 | `POST /doc/files/import` 不做（依赖 file 域对象复制管线） | 06 §4.8、D05 §3.11 |
| 10 | WS 事件 | doc.updated/doc.presence/doc.mention/doc.access.requested 四事件不做（无协作/推送场景；列表刷新走写操作后 Query 精准失效） | 06 §6.2、D05 §5.4 |
| 11 | doc_card | 简版：body `{doc_id,title,version}`，气泡渲染标题+版本+点击跳 `/doc/:id`（编辑器「发卡片」经 WS msg.send 直发）；在线状态点/协作头像/摘要预览/转发授权判定不做 | 06 §4.8、D05 §3.12 |
| 12 | markdown 渲染 | 自研简版 MarkdownLite（标题/无序/有序列表/fenced 代码块/引用/粗体/行内码；React 节点拼接零 innerHTML）；表格/图片/链接/成熟渲染库阶段二（任务书口径"现有 im MarkdownText 或简单 pre"——repo 无现成组件，落简版自绘） | D05 §3.8 |
| 13 | 客户端列表 | 无虚拟滚动/视图切换（列表/紧凑/画廊）/列配置/批量操作/右键菜单（改行内按钮）/拖拽移动（无 doc_folder）；搜索为 Enter 提交（400ms 防抖不做） | D05 §3.1/§3.2 |
| 14 | 最近打开 | localStorage LRU ≤20（任务书指定；D05 §6.2 local_doc_recent SQLite 表与登出清除阶段二随 Tauri 落地） | D05 §6.2 |
| 15 | 权限点 | doc:* 权限点字典不接入（v0.1 全 owner 私有即天然鉴权；03 篇登记后接入） | 06 §6.4 |
| 16 | 审计 | doc 域审计留痕不做（audit 域哈希链阶段二联动） | 06 §4.4 |

错误码：6001-6015 均已注册于 `server/internal/platform/errors/codes.go` 与 docs/14 篇 §7（无需补登记）；客户端 `shared/api/http.ts` 文案表本轮补 6004/6007/6011/6013/6015。

## 五、全绿门禁

- 服务端：`go build ./...` ✓ `go vet ./...` ✓ `gofmt -l` 空 ✓ `go test ./...` 全绿（doc 域 6 个用例：主链路/乐观锁冲突/回收站/owner 私有/翻页/分享占位）✓
- PG 集成（`-tags pg`，本机 bbw 容器）：迁移 0011 真实落库（两表+RLS+UK）+ 仓储/服务冒烟全绿 ✓（advisory lock 9116/9117 分配验证）
- 客户端：`npx tsc -b --noEmit`（strict）✓ `npm run build` ✓

## 六、复现 E2E

```bash
# 服务端（终端 1，内存模式 :8090）
cd server && BBW_HTTP_ADDR=:8090 \
  BBW_JWT_SECRET=dev-secret-0123456789abcdef0123456789 \
  BBW_CORS_ORIGINS="http://localhost:4173,http://127.0.0.1:4173" \
  go run ./cmd/bbw-server

# 客户端（终端 2，preview :4173）
cd client && VITE_USE_MOCK=0 VITE_API_BASE=http://127.0.0.1:8090/api/v1 \
  VITE_WS_BASE=ws://127.0.0.1:8090/ws/connect npm run build && \
  npx vite preview --port 4173 --strictPort

# 浏览器登录 alice / demo-pass-123 → 左栏「文档」
# 建文档 → 编辑 Cmd/Ctrl+S（v2/v3）→ 版本时间线 → 恢复 v2（v4）→ 预览 →
# 双标签页同基线保存（6004 红条→强制覆盖）→ 移入回收站 → 同名新建 → 回收站恢复（后缀）→
# 编辑器「发卡片」→ /im 查看 doc_card → 点击卡片回到 /doc/:id
```

## 七、遗留（阶段二建议顺序）

1. doc_share 落库 + 外链解析页 + 密码/禁止下载/撤销（6008/6009 已有码位）；
2. scope=space 域 + resource_acl 三层判定接入（6001 转正）+ 权限申请审批流（doc_access_req 表）；
3. 回收站到期物理清除定时任务 + 彻底删除/清空（doc:trash:purge）；
4. 版本 auto/close 快照（需编辑会话）、版本对比/下载票据；
5. markdown 渲染换成熟库（表格/图片/链接）+ 虚拟滚动列表；
6. WOPI/OnlyOffice 全量（06 §4.1-§4.3）与聊天文件转协作文档（import）。
