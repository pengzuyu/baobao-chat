# BaobaoChat 插件开发指南

> 一个插件包 = 一组 Agent 能力的分发单元：**技能 / 工具 / 命令 / 专家** 四类组件按需携带，
> 用户安装后即时生效（工具进 `mcp.<插件名>.*` 命名空间、技能按触发词注入、命令 `/` 渲染、专家可被会诊选中）。
> 设计全貌见 [D22-插件系统详细设计](../../docs/detail/D22-插件系统详细设计.md)；本文面向插件作者。

## 快速开始（5 分钟）

```bash
# 1. 拷示例包改名（示例包含四类组件全量写法 + 零依赖 MCP server）
cp -r examples/plugins/hello-baobao examples/plugins/my-plugin
cd examples/plugins/my-plugin
#    改 .bbc-plugin/plugin.json 的 name/description（name 即全局唯一 id）

# 2. 本地自测 stdio 工具（可选；行协议=每行一个 JSON）
node server.mjs   # 粘贴一行 initialize 看应答，Ctrl-C 退出

# 3. 打包上传（任选其一）
zip -qr my-plugin.zip my-plugin -x "*.DS_Store"
#    · 个人上传：桌面端 → 工作台 → 插件 → 「上传插件」（draft 仅自己可见可装，随时迭代）
#    · 公共发布：管理员 → 管理台 → 插件 → 上传公共插件 → 版本线 → 发布进公共市场

# 4. 安装验证：插件页点安装 → 会话里说触发词 / 敲 / 命令 / 让模型调 mcp.<插件名>.* 工具
```

## 包结构

```
my-plugin/
├── .bbc-plugin/plugin.json   # 清单（也认 .claude-plugin/ 与 .zcode-plugin/——Claude/ZCode 生态包可直装）
├── skills/<名>/SKILL.md      # ① 技能：知识/流程，按触发词注入会话
├── commands/<名>.md          # ② 命令：提示词模板，输入框 / 唤起
├── agents/<名>.md            # ③ 专家：受限子会话人格
├── .mcp.json                 # ④ 工具：MCP server 定义（stdio 子进程或远程 HTTP）
├── server.mjs                #    （stdio 形态时）server 实现，任意语言均可
└── hooks/hooks.json          #    预留：校验合法性，当前不执行
```

zip 打包时**顶层允许套一层目录**（`my-plugin/...` 或直接根内容均可，服务端自动识别）。

## plugin.json 字段

```jsonc
{
  "name": "my-plugin",          // 必填：全局唯一 id。小写字母数字与 . _ -，字母数字开头，≤64
  "version": "1.0.0",           // 必填：语义化 x.y.z；同号重传会被拒（版本递增才可更新）
  "description": "一句话说明",    // 必填：≤200 字，市场检索语料
  "author": { "name": "你的团队" },
  "skills": "./skills",         // 组件目录（缺省自动发现同名默认目录，一般不用写）
  "commands": "./commands",
  "agents": "./agents",
  "mcpServers": "./.mcp.json",  // 或直接内联对象：{"mcpServers": {...}}
  "bbc": {                      // BaobaoChat 扩展块（Claude/ZCode 兼容包可无此块）
    "risk": "low",              // low|medium|high：插件级默认风险（工具级 x-bbc-risk 优先）
    "category": "devops",       // 市场分类
    "netAllow": ["*.corp.internal"], // 网络访问声明（v0.1 安装确认页展示，强制执行阶段二）
    "config": [                 // 用户配置项：详情页渲染表单
      { "key": "api_token", "label": "API Token", "type": "secret", "required": true },
      { "key": "base_url",  "label": "服务地址",   "type": "string" }
    ]
  }
}
```

## 四类组件写法

### ① 技能 skills/*/SKILL.md

```markdown
---
name: my-skill
description: 一句话描述（进「技能索引区」供模型知晓存在）
triggers: [发版, 上线]     # 可省：省略时兜底以 name 作触发词
allowedTools: [read_file]  # 可省：命中时收紧工具面到并集
risk: medium               # 可省，缺省 low
---
（正文 = 触发后注入会话的指令/知识。命中注入 ≤3 条，写精不写多）
```

### ② 工具 .mcp.json（核心组件）

工具一律以 MCP server 形态提供（语言无关）。两种形态：

```jsonc
{
  "mcpServers": {
    // 形态一：stdio 子进程（自包含，推荐）
    "my-plugin": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/server.mjs"],   // ${PLUGIN_ROOT} = 安装后的版本目录绝对路径
      "env": { "MY_TOKEN": "${CONFIG:api_token}" }  // 配置项注入（见变量族）
    },
    // 形态二：远程 HTTP（内网服务/网关；secret 型鉴权头走这里）
    "my-remote": {
      "url": "https://bbc.corp.internal/mcp/kb",
      "headers": { "Authorization": "Bearer ${BBC_USER_TOKEN}" }
    }
  }
}
```

- server 名（`my-plugin`/`my-remote`）= 工具命名空间段：模型侧工具全名 `mcp.<server名>.<工具名>`；**不能叫 `corp`**（系统级保留）
- stdio 行协议与最小实现：**直接抄 `hello-baobao/server.mjs`**（~100 行零依赖，initialize/tools/list/tools/call 四方法注释齐全）
- 工具风险标注：tools/list 的 `annotations["x-bbc-risk"] = "low|medium|high"`（缺省承插件 bbc.risk，再缺省 medium）；所有工具与内置工具走同一审批门控，无特权
- 业务失败请返回 `isError: true` 的**结果**（模型可自行处置），JSON-RPC error 只用于协议错误

### ③ 命令 commands/*.md

```markdown
---
name: release            # 必须单词（/name args 解析依赖）
description: 发布检查单
---
（正文 = 提示词模板。占位符：$ARGUMENTS=全部参数拼接，$1..$9=位置参数。
 用户敲 /release 生产环境 12:00 → 模板中 $ARGUMENTS→"生产环境 12:00"、$1→"生产环境"）
```

### ④ 专家 agents/*.md

```markdown
---
name: release-verifier
description: 发布验收专家
tools: read_file, mcp.my-plugin.check_status   # 可省=全量；mcp.* 进 MCP 白名单，其余进内置白名单
model: fast                                     # fast|strong（缺省 strong）
---
（正文 = 专家人格 system prompt；运行时是受限子会话：独立上下文、步数/预算受控）
```

## 变量族（.mcp.json 中可用）

| 变量 | 值 | 替换时机 |
|---|---|---|
| `${PLUGIN_ROOT}` | 安装后的版本目录绝对路径 | 宿主装配时（静态） |
| `${BBC_USER_TOKEN}` | 当前登录用户 JWT | **仅 HTTP headers**，Runtime 每次请求动态替换（15 分钟轮换不失效）；stdio env 中会置空——**同生态身份一律走 HTTP 形态** |
| `${BBC_USER_ID}` / `${BBC_USER_NAME}` | 工号 / 姓名 | 宿主装配时（换账号自动重推） |
| `${CONFIG:<key>}` | 用户在详情页配置的值（secret 型存系统钥匙串，不落盘） | 宿主装配时；未配置保留占位符（外部系统 401 比伪值诚实），**保存配置即自动重推装配** |

## 发布校验清单（过审要点）

服务端发布时全部强制，客户端安装前复跑：

1. zip ≤ 10MB，单文件 ≤ 4MB
2. 清单存在且可解析（三目录名任一）
3. `name`/`version` 格式合法；**空插件拒**（至少一类组件）
4. 全部条目无路径穿越（`../`、绝对路径、反斜杠）
5. `.mcp.json` 可解析；每个 server 有 `command`（stdio）或 `url`（HTTP，http(s)://）
6. 声明的组件目录存在且非空；hooks.json 合法 JSON（不执行）

## 生命周期与调试

| 操作 | 行为 |
|---|---|
| 安装 | 下载 → 校验 → 落盘 `{dataDir}/eco/plugins/<id>/<版本>/` → 即时装配（进行中会话下一轮生效） |
| 更新 | 新版本落新目录，激活切换；失败自动回滚旧版（旧版保留一份） |
| 禁用/启用 | 只改装配，不删文件 |
| 卸载 | 删目录；**用户配置与钥匙串默认保留**（重装即复用） |

调试入口：
- 安装目录：`~/Library/Application Support/com.baobaochat.client/agent-runtime/eco/plugins/<id>/`（`plugin-state.json` = 启用态+激活版本）
- MCP 连接日志：同目录上级的 `bbrt.log`（`grep '懒补连\|连接降级'`——stdio server 启动失败/坏协议会在这里现形）
- stdio server 单测：`node server.mjs` 手工粘贴 JSON 行（stdout 是协议通道，**日志必须走 stderr**）
- 装完没生效？确认插件页「已安装」开关开着，新开会话再试（`mcp.config` 在宿主重启后也会重推，重启桌面端可兜底）

## 分发渠道

| 渠道 | 入口 | 可见性 |
|---|---|---|
| 个人上传（自用沙盒） | 桌面端·插件页·「上传插件」 | 仅本人，draft 即可装，随时迭代 |
| 公共市场 | 管理台·插件·上传→版本线→「发布进公共市场」 | 全员（管理员审核）；三档策略：force=全员推发免确认 / recommend=置顶推荐 / optional=自愿 |

---

**下一步建议**：通读 `hello-baobao/` 全部文件（每个文件都有注释讲清对应组件的规则），拷贝改名即可开工。
