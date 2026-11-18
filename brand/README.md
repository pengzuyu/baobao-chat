# brand/ —— 品牌白标唯一改动面（D31）

内网自部署方换自己的名字与 logo，**只改本目录**，不碰源代码：

```
brand/
  brand.json       品牌配置（名字/标语/版权行/设备名/邮箱后缀 + identity 身份区）
  assets/
    logo.svg       UI 内 logo（登录页/侧栏/关于页 + favicon 源）
    icon.png       1024×1024 OS 图标源图（安装包/dock/任务栏图标由此生成）
```

## 五步换牌

1. 改 `brand.json` 的品牌字段（`name`/`page_title`/`tagline`/`copyright`/`device_name`/`mail_domain`）；
2. 替换 `assets/logo.svg`（UI 内 logo）与 `assets/icon.png`（1024×1024 应用图标源图）；
3. 跑 `make brand`（= 生成产物 + `tauri icon` 重生成全套 OS 图标）；
4. 启用应用内自动更新才需：`npm run tauri signer generate` 自备密钥，公钥填 `brand.json` 的 `updater_pubkey`，出包时带 `TAURI_SIGNING_PRIVATE_KEY` 环境变量；
5. 按常规出包：`BBC_PUBLIC_URL=http://你的域名 bash scripts/release/build-desktop.sh`（品牌产物一致性由脚本内置 `--check` 门禁把守）。

只改了 `brand.json` 没换图标时，日常跑 `make brand-conf` 即可（不动 icons/）。

## ⚠ identity 身份区（默认勿动）

`identity.identifier` 与 `identity.deep_link_scheme` 是**身份标识而非品牌**，默认锁定：

| 字段 | 改动后果 |
|---|---|
| `identifier` | appData/钥匙串数据目录整体迁移——老用户**全员静默登出**、本地数据「消失」无任何报错 |
| `deep_link_scheme` | 服务端 `BBC_DEEP_LINK_SCHEME` 必须同步改（deploy/compose/.env），否则 OIDC 深链确认登录**静默失效** |

确实需要改（如双品牌共存一台机器）时，生成器会打红字警告，请同时评估上表两行。

## ✉ mail_domain 邮箱统一后缀（2026-11-18；定死型配置）

企业邮箱的统一后缀域（新建用户表单默认 `工号@mail_domain`，可改前缀）。**产品面无修改入口，构建期定死**：
只随换牌改一次，改后历史用户邮箱地址不变（新旧后缀并存）。改动时生成器打红字警告，且必须同步服务端
`BBC_MAIL_DOMAIN`（deploy/compose/.env → app 服务 / helm `config.mailDomain`）——初始管理员邮箱与
mail 模块懒开户（`工号@域`）均以该 env 为源，与 `brand.json` 保持同值。

## 产物去向（全部 committed，勿手改）

| 产物 | 由 | 消费方 |
|---|---|---|
| `client/src/shared/brand.ts` | gen.mjs | 前端全部品牌文案触点 |
| `client/src-tauri/src/brand.rs` | gen.mjs | 壳深链 register 等常量 |
| `client/src-tauri/tauri.conf.json`（productName/identifier/标题/scheme/pubkey） | gen.mjs 原地 patch | tauri build / NSIS 快捷方式名 |
| `client/public/logo.svg` | assets 复制 | Logo 组件 / favicon |
| `client/index.html` `<title>` | page_title | webview 文档标题 |
| `client/src-tauri/icons/` 全套 | `make brand`（tauri icon） | 安装包/dock/任务栏图标 |

上游贡献者注意：改完 `brand.json` 必跑 `make brand-conf` 再提交（`--check` 门禁会拦过期产物）。
