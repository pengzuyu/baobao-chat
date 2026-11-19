#!/usr/bin/env node
/**
 * 节假日日历外网取数脚本（D35）——**只在外网机器上手工运行**，服务端不调用任何外网接口。
 *
 * 用法（Node 18+，需外网）：
 *   node scripts/holiday-export.mjs 2026 > calendar-2026.json
 * 然后把 JSON 文件带回内网，在「管理 → 工作日日历 → 导入」上传/粘贴，
 * 先「预览差异」再「确认导入」。
 *
 * 输出 schema（与服务端导入一致）：
 *   { "version": 1, "year": 2026, "region": "CN",
 *     "days": [{ "date":"2026-10-01", "type":"holiday", "name":"国庆节" }] }
 *   type: holiday=节假日 / workday=调休上班（周末上班）
 *   省略的日期按默认规则（周一~五工作日、六日周末）。
 *
 * 数据源：timor.tech 公开节假日 API（外网；如不可用可换成其它公开源，
 * 只要最终产出上面的 schema 即可）。失败时退出码非 0，不产出半成品文件。
 */

const year = Number(process.argv[2] || new Date().getFullYear());
if (!Number.isInteger(year) || year < 2000 || year > 2100) {
  console.error('用法：node scripts/holiday-export.mjs <年份，如 2026>');
  process.exit(2);
}

const url = `https://timor.tech/api/holiday/year/${year}`;

function fail(msg) {
  console.error(`[holiday-export] ${msg}`);
  process.exit(1);
}

const res = await fetch(url, { headers: { accept: 'application/json' } }).catch((e) =>
  fail(`请求失败：${e.message}`),
);
if (!res.ok) fail(`接口返回 HTTP ${res.status}`);
const body = await res.json().catch((e) => fail(`JSON 解析失败：${e.message}`));
if (body.code !== 0 || !body.holiday || typeof body.holiday !== 'object') {
  fail(`接口返回异常：${JSON.stringify(body).slice(0, 200)}`);
}

const days = [];
for (const [key, item] of Object.entries(body.holiday)) {
  // key=MM-DD；item.date=YYYY-MM-DD（缺失时按年份拼）
  const date = item.date || `${year}-${key}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(String(year))) continue;
  // holiday=true → 放假（节假日）；false → 调休上班（工作日）
  days.push({
    date,
    type: item.holiday ? 'holiday' : 'workday',
    name: (item.name || '').trim(),
  });
}
days.sort((a, b) => a.date.localeCompare(b.date));

if (days.length === 0) fail(`${year} 年没有取到任何节假日/调休数据（接口可能尚未发布该年）`);

process.stdout.write(
  JSON.stringify({ version: 1, year, region: 'CN', days }, null, 2) + '\n',
);