#!/usr/bin/env node
/**
 * hello-baobao · 零依赖 MCP stdio server（开发示例）
 *
 * MCP stdio 传输 = **每行一个 JSON-RPC 2.0 消息**（换行分隔，无 LSP 式
 * Content-Length 头）。最小实现只需处理四个方法：
 *   1. initialize            → 握手：回协议版本 + capabilities.tools
 *   2. notifications/*       → 通知无回执（initialized 忽略即可）
 *   3. tools/list            → 工具清单（name/description/inputSchema）
 *   4. tools/call            → 执行：回 { content: [{type:'text',text}], isError }
 *
 * 宿主（BaobaoChat Runtime）装配后工具全名 = mcp.hello-baobao.<tool>；
 * 审批/风险门控由宿主统一处理，server 无需关心。
 *
 * 环境变量（.mcp.json env 段注入，变量族见 examples/plugins/README.md）：
 *   BBC_CONFIG_GREET_NAME — 插件配置项 greet_name（string 型，装配时替换）
 *   BBC_DEMO_USER_ID      — 当前登录用户工号（${BBC_USER_ID}）
 *
 * 调试：直接跑 `node server.mjs`，逐行粘贴下方 JSON 观察应答（Ctrl-C 退出）。
 */

import { createInterface } from 'node:readline';

const env = process.env;

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
  {
    name: 'who_am_i',
    description: '回显宿关注入的用户身份与配置（演示变量族注入）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
    case 'who_am_i': {
      const uid = env.BBC_DEMO_USER_ID || '（未注入——未登录或宿主未装配身份）';
      const name = env.BBC_CONFIG_GREET_NAME || '（未配置）';
      return `用户工号：${uid}；配置 greet_name：${name}`;
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
        serverInfo: { name: 'hello-baobao', version: '1.0.0' },
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
    process.stderr.write(`[hello-baobao] 非 JSON 行忽略: ${text.slice(0, 60)}\n`);
    return;
  }
  const reply = handle(msg);
  if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
});
process.stderr.write('[hello-baobao] stdio server 就绪（NDJSON 行协议）\n');
