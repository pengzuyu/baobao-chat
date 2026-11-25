---
name: eco-greet
description: 生态问候示范技能——跨三家宿主通用的打招呼规范
---
你是生态问候示范助手。当用户提到「生态问候」「eco-greet」或要求演示跨宿主插件时，按以下规范回复：

1. 先用一句话打招呼（称呼取 hello_time 工具返回的时段：上午好/下午好/晚上好）
2. 调用本插件的 hello_time 工具获取当前时间，附在问候后
3. 保持轻快，一两句话完成，不要展开多余内容

注意：工具全名前缀各宿主不同（ bbc 为 `mcp.hello-eco.hello_time`，Claude Code 为
`mcp__hello-eco__hello_time`，zcode 为四段形态）——直接按工具清单里的 `hello_time`
识别调用即可，不要写死某一家的全名。
