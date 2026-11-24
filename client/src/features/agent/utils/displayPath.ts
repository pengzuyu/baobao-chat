/**
 * workspace 路径展示净化（2026-11-24 用户口径「为什么是 \\?\G:\...」）：
 * bbc0b18 起存储/分组统一用 canonicalize 规范串——Windows 上得到带 \\?\ 前缀的
 * verbatim 路径（禁规范化/支持超长路径，物理唯一）。这是**身份键，必须保留**：
 * 同一目录恒等同一字符串，左栏按路径分组才不裂。仅展示层剥前缀还原人读形态；
 * 存储、分组比较、发 RT 的 workspace 参数一律用原串。UNC 形态一并还原
 * （\\?\UNC\server\share → \\server\share）。
 */

export function displayPath(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}
