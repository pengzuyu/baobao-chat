/**
 * scope 人类可读标签单源（D28）：授权确认卡 / 设置·已授权应用 / 管理端·登录接入
 * 三处共用；未映射的（自定义权限点）回退原码——权限点字典后续接。
 */

export const SCOPE_LABEL: Record<string, string> = {
  openid: '身份标识',
  profile: '基础资料',
  email: '邮箱地址',
  offline_access: '离线保持登录',
  'kb:query:use': '知识库检索',
  'kb:doc:contribute': '知识库投稿',
  'im:message:send': '发送消息',
};

export function scopeLabel(s: string): string {
  return SCOPE_LABEL[s] ?? s;
}
