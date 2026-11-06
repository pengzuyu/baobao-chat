/** 时间格式化（D03 §3.1：今天 HH:mm / 本周 周X / 更早 MM-DD；正式版接入 i18n 本地化） */

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 会话列表时间 */
export function formatListTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  if (now.getTime() - ts < weekMs) {
    return `周${['日', '一', '二', '三', '四', '五', '六'][d.getDay()]}`;
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 消息流日期分隔条 key（同日归组） */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 消息流日期分隔条文案 */
export function formatDayDivider(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天';
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
