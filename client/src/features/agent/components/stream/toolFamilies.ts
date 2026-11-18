/**
 * 工具家族分类（D33 §3.5）：classifyTool 按「内置 snake_case + 委派后端
 * PascalCase（normalize.rs 归一化的外部 CLI 工具名）」双命名映射到渲染家族；
 * 家族决定头部动作词/图标/关键参数提取与展开体形态（编辑=红绿 diff、
 * 终端=$命令+输出块、MCP=server 徽标拆解……）。未识别落 generic 兜底。
 * 本产品无删除文件工具（安全设计）——外部后端若有按 generic 如实显示。
 */

import {
  Brain,
  FilePen,
  FilePlus,
  FileText,
  GitBranch,
  Globe,
  HelpCircle,
  Plug,
  Radar,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export type ToolFamily =
  | 'fileRead'
  | 'fileWrite'
  | 'fileEdit'
  | 'search'
  | 'terminal'
  | 'git'
  | 'web'
  | 'memory'
  | 'ask'
  | 'mcp'
  | 'internal'
  | 'generic';

export interface ToolFamilyMeta {
  family: ToolFamily;
  /** 头部动作词（中文；git/memory 按具体工具细分） */
  label: string;
  icon: LucideIcon;
}

/** MCP 工具名拆解：内部 `mcp.{server}.{tool}` / 外部 `mcp__{server}__{tool}` */
export function splitMcpName(tool: string): { server: string; rest: string } | null {
  if (tool.startsWith('mcp.')) {
    const parts = tool.split('.');
    if (parts.length >= 3) return { server: parts[1], rest: parts.slice(2).join('.') };
    return { server: parts[1] ?? '', rest: parts.slice(2).join('.') };
  }
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__');
    if (parts.length >= 3) return { server: parts[1], rest: parts.slice(2).join('__') };
  }
  return null;
}

const GIT_LABELS: Record<string, string> = {
  git_status: 'Git 状态',
  git_diff: 'Git 差异',
  git_commit: 'Git 提交',
  git_push: 'Git 推送',
};

const MEMORY_LABELS: Record<string, string> = {
  memory_save: '记忆保存',
  memory_forget: '记忆移除',
  memory_read: '记忆读取',
};

const INTERNAL_TOOLS = new Set(['subagent.adjust', 'subagent.cancel', 'coding.delegate']);

/** 工具名 → 家族元信息（含内置与外部双命名映射） */
export function classifyTool(tool: string): ToolFamilyMeta {
  if (tool === 'skill') return { family: 'generic', label: '技能', icon: Wrench }; // 实际渲染走 SkillCard，此分支不达
  if (splitMcpName(tool)) return { family: 'mcp', label: 'MCP', icon: Plug };
  if (INTERNAL_TOOLS.has(tool)) return { family: 'internal', label: '内部', icon: Radar };
  switch (tool) {
    case 'read_file':
    case 'Read':
      return { family: 'fileRead', label: '读取', icon: FileText };
    case 'list_dir':
    case 'LS':
      return { family: 'fileRead', label: '列目录', icon: FileText };
    case 'write_file':
    case 'Write':
      return { family: 'fileWrite', label: '写入', icon: FilePlus };
    case 'edit_file':
    case 'Edit':
    case 'Update':
      return { family: 'fileEdit', label: '编辑', icon: FilePen };
    case 'search_files':
    case 'Grep':
    case 'Glob':
      return { family: 'search', label: '搜索', icon: Search };
    case 'run_command':
    case 'Bash':
    case 'Shell':
      return { family: 'terminal', label: '终端', icon: Terminal };
    case 'http_fetch':
    case 'WebFetch':
    case 'WebSearch':
      return { family: 'web', label: '网络', icon: Globe };
    case 'ask_user':
      return { family: 'ask', label: '提问', icon: HelpCircle };
    default:
      break;
  }
  if (GIT_LABELS[tool]) return { family: 'git', label: GIT_LABELS[tool], icon: GitBranch };
  if (MEMORY_LABELS[tool]) return { family: 'memory', label: MEMORY_LABELS[tool], icon: Brain };
  return { family: 'generic', label: tool, icon: Wrench };
}

/** args 取首个字符串值（按候选键序） */
function pickStr(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v) return v;
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v.join(' ');
  }
  return undefined;
}

/** 头部行内关键参数（单行截断展示）：路径/查询/命令/URL…… */
export function toolHeadParam(tool: string, args: Record<string, unknown>): string | undefined {
  const meta = classifyTool(tool);
  switch (meta.family) {
    case 'fileRead':
    case 'fileWrite':
    case 'fileEdit':
      return pickStr(args, ['path', 'file_path', 'absolute_path']);
    case 'search':
      return pickStr(args, ['query', 'pattern', 'q', 'path']);
    case 'terminal':
      return pickStr(args, ['command', 'cmd']);
    case 'web':
      return pickStr(args, ['url', 'input', 'query']);
    case 'memory':
    case 'ask':
      return pickStr(args, ['name', 'memory_type', 'contains', 'question']);
    case 'mcp': {
      const m = splitMcpName(tool);
      return m?.rest || tool;
    }
    case 'internal':
    case 'generic':
    default: {
      // 现口径（toolCallCommand 同语义）：首个字符串参数
      const v = Object.values(args).find((x): x is string => typeof x === 'string' && !!x);
      return v || undefined;
    }
  }
}

/** 写入类内容规模（头部 `· N 行`）：args.content 行数 */
export function contentScale(args: Record<string, unknown>): { lines: number; chars: number } | null {
  const c = args.content ?? args.contents;
  if (typeof c !== 'string' || !c) return null;
  const lines = c.split('\n').length;
  return { lines, chars: [...c].length };
}

/** 编辑类 diff 取参（内置 old/new；外部 old_string/new_string 或 content） */
export function editDiffArgs(args: Record<string, unknown>): { oldText?: string; newText?: string } {
  const oldText = pickStr(args, ['old', 'old_string', 'oldStr']);
  const newText = pickStr(args, ['new', 'new_string', 'newStr']);
  return { oldText, newText };
}
