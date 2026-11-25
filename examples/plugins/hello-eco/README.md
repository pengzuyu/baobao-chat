# hello-eco · 生态形态示例插件（三家通装）

`hello-baobao` 示范 bbc 全能力；本包示范**同一份包在 BaobaoChat / Claude Code /
zcode 三家通装**的生态兼容写法。与 hello-baobao 的关键差异：

| 写法项 | hello-baobao（bbc 原生） | hello-eco（生态形态，本包） |
|---|---|---|
| 清单目录 | `.bbc-plugin/` | `.claude-plugin/` + `.zcode-plugin/` **双目录同内容**（bbc 按优先级读 `.claude-plugin`，Claude Code 只认前者，zcode 规范用后者） |
| 根路径变量 | `${PLUGIN_ROOT}` | `${CLAUDE_PLUGIN_ROOT}`（生态标准名；bbc 视为别名同义展开） |
| 配置/身份占位 | `${CONFIG:*}` / `${BBC_USER_*}` | **不用**（两家无对应机制；配置需求改走用户自设环境变量） |
| 技能 frontmatter | `triggers`/`risk` 等 bbc 字段 | 仅 `name`/`description`（Claude 格式；bbc 兜底以 name 作触发词+进技能索引区） |
| 专家 frontmatter | `tools:`/`model:` 白名单 | **都不写**（三家命名空间/模型档不同，不写=继承全量通用） |
| `bbc` 扩展块 | 全量（config 等） | 最小保留 `risk`/`category`（两家忽略未知字段，示范共存口径） |

四类组件（技能/命令/专家/stdio 工具）与 hello-baobao 同构——对照两个包的
同名文件即可看清每一处写法差异。

## 三家安装

**BaobaoChat**（zip 上传，与 hello-baobao 同路）：

```bash
cd examples/plugins && zip -qr hello-eco.zip hello-eco -x "*.DS_Store"
# 桌面端 → 工作台 → 插件 → 「上传插件」选 hello-eco.zip
```

**Claude Code**（本地 marketplace；examples/plugins/ 目录已带 marketplace.json）：

```
/plugin marketplace add /path/to/baobao-work/examples/plugins
/plugin install hello-eco@baobao-examples
```

**zcode**（UI 添加本地市场）：

插件市场 → Add → Add Plugin Marketplace → 粘贴
`/path/to/baobao-work/examples/plugins` 目录 → Personal → baobao-examples →
hello-eco → Install。

## 验证要点

- 三家各装一次，会话里说「生态问候」/ 敲 `/eco` / 让模型调 `hello_time`；
- bbc 内工具全名 `mcp.hello-eco.hello_time`（stdio server 应正常启动——
  这同时验证 `${CLAUDE_PLUGIN_ROOT}` 生态别名展开）；
- Claude Code / zcode 侧工具全名为双下划线/四段形态，功能一致。
