#!/usr/bin/env node
/**
 * hello-eco · 零依赖 MCP stdio server（生态形态示例——三家通装）
 *
 * 与 hello-baobao/server.mjs 的差异：本包按 Claude Code / zcode 兼容写法打包，
 * 不使用任何 bbc 特有占位（${CONFIG:*} / ${BBC_USER_*}）——那些只有 BaobaoChat
 * 装配器认识，另外两家会原样透传导致功能缺损。生态包的配置类需求改走用户
 * 自设环境变量（.mcp.json 的 env 段引用 ${VAR} 由各宿主从环境展开）。
 *
 * 脚本定位用生态标准变量 ${CLAUDE_PLUGIN_ROOT}（见 .mcp.json args）：
 * Claude Code / zcode 原生展开；BaobaoChat 装配器将其视为 ${PLUGIN_ROOT}
 * 的别名同义展开——一个变量名三家通用。
 *
 * MCP stdio 传输 = 每行一个 JSON-RPC 2.0 消息（NDJSON）。最小实现四方法：
 *   initialize / notifications/*（忽略）/ tools/list / tools/call
 *
 * 注意：工具全名前缀三家不同（bbc mcp.hello-eco.* / Claude Code
 * mcp__hello-eco__* / zcode 四段），本文件不感知——命名空间由宿主装配。
 *
 * 调试：直接跑 `node server.mjs`，逐行粘贴 JSON 观察应答（Ctrl-C 退出）。
 */

import { createInterface } from 'node:readline';

/** 工具清单（inputSchema = JSON Schema；宿主据此生成模型侧 tool 定义） */
const TOOLS = [
  {
    name: 'hello_time',
    description: '获取当前时间与时段问候（上午好/下午好/晚上好）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'roll_dice',
    description: '掷骰子（演示带参数的工具）',
    inputSchema: {
      type: 'object',
      properties: {
        sides: { type: 'number', description: '面数（默认 6）' },
      },
      additionalProperties: false,
    },
  },
];

/** 工具实现（MCP 语义：业务失败返回 isError:true 的**结果**，而非 JSON-RPC error） */
function callTool(name, args) {
  switch (name) {
    case 'hello_time': {
      const now = new Date();
      const h = now.getHours();
      const part = h < 12 ? '上午好' : h < 18 ? '下午好' : '晚上好';
      return `${part}——现在是 ${now.toLocaleString('zh-CN', { hour12: false })}`;
    }
    case 'roll_dice': {
      const sides = Number(args?.sides) || 6;
      if (sides < 2 || sides > 1000) {
        return { text: `面数非法（2-1000）：${sides}`, isError: true };
      }
      return `掷出 ${Math.floor(Math.random() * sides) + 1} 点（${sides} 面骰）`;
    }
    default:
      return { text: `未知工具：${name}`, isError: true };
  }
}

/** JSON-RPC 分发 */
function handle(msg) {
  const { id, method, params } = msg;
  if (method?.startsWith('notifications/')) return null; // 通知无回执
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'hello-eco', version: '1.0.0' },
      });
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const out = callTool(params?.name, params?.arguments ?? {});
      const text = typeof out === 'string' ? out : out.text;
      const isError = typeof out === 'object' && out.isError === true;
      return reply({ content: [{ type: 'text', text }], isError });
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `方法不存在: ${method}` } };
  }
}

// 行协议主循环：stdin 每行一条消息，应答写 stdout（日志走 stderr——stdout 是协议通道！）
createInterface({ input: process.stdin }).on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    process.stderr.write(`[hello-eco] 非 JSON 行忽略: ${text.slice(0, 60)}\n`);
    return;
  }
  const reply = handle(msg);
  if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
});
process.stderr.write('[hello-eco] stdio server 就绪（NDJSON 行协议）\n');
