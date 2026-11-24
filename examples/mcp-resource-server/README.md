# 生态应用 MCP 统一身份示例（最小资源服务器）

D38 agent 票（ES256 单票制）的**资源服务器侧**最小接入示例：agent 带bbc 签发的
统一身份票调你的 MCP 端点，你只需**本地验签**——无 key、无登记、无对 bbc 的出站依赖。

```bash
# 前提：bbc-server 已起（默认 :8080）+ 桌面端已登录 + 装了声明 x-bbc-auth 的插件
# （或临时改用个人 MCP：URL 填本示例端点 + 勾「以我的身份调用」）

# 本示例默认受众 = 自己的端点地址 http://127.0.0.1:7081/mcp
BBC_ISSUER=http://127.0.0.1:8080/oauth2 PORT=7081 go run .

# 桌面端个人 MCP 新增：
#   名称 mcp-demo / HTTP / URL http://127.0.0.1:7081/mcp / 勾「以我的身份调用」
# 会话里调用 mcp-demo.whoami → 回显票内 sub/act/scope（证明链路通）
```

三条验收（对应 D38 §9-11/12）：

| # | 操作 | 期望 |
|---|---|---|
| 1 | 会话调 `mcp-demo.whoami` | 200，content 显示 `sub=你的uid act=desktop-…` |
| 2 | 把受众改成别的地址再调 | 401 `aud 不含本端点`（串票拒绝） |
| 3 | 换 bbc 签名密钥（BBC_OIDC_SIGNING_KEY）重启后调用 | kid miss → 自动重拉 jwks → 恢复 |

接入说明详见 [docs/生态应用MCP接入指南.md](../../docs/生态应用MCP接入指南.md)。
