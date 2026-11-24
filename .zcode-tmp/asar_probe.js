// 只读探查 ZCode.app/Contents/Resources/app.asar（不修改任何应用文件）
// 用法: node asar_probe.js <模式>
//   list            : 列出 asar 内文件清单
//   read <path>     : 输出 asar 内指定文件内容
//   find <关键词>   : 在 asar 内所有 JS/JSON 文本中搜索关键词，打印文件与上下文片段
const fs = require('fs');
const ASAR = '/Applications/ZCode.app/Contents/Resources/app.asar';
const buf = fs.readFileSync(ASAR);

// ---- asar 头部解析 ----
// [0..3] uint32 = 4, [4..7] uint32 = header pickle 大小, [8..11] uint32 = 头部 JSON 字符串长度, [12..] = JSON
const pickleSize = buf.readUInt32LE(4);
const strLen = buf.readUInt32LE(8);
const jsonStart = buf.indexOf('{"files"', 8, 'utf8');
if (jsonStart === -1) { console.error('未找到头部 JSON'); process.exit(1); }
const headerJson = JSON.parse(buf.slice(jsonStart, jsonStart + strLen).toString('utf8'));
const baseOffset = 8 + pickleSize;

function walk(node, prefix, out) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, prefix + '/' + name, out);
  } else {
    out.push({ file: prefix, size: node.size, offset: node.offset });
  }
}
const files = [];
walk(headerJson, '', files);

const mode = process.argv[2] || 'list';
if (mode === 'list') {
  for (const f of files) console.log(`${f.size}\t${f.offset}\t${f.file}`);
  console.log(`TOTAL_FILES=${files.length}`);
  process.exit(0);
}

if (mode === 'read') {
  const p = process.argv[3];
  const f = files.find(x => x.file === p);
  if (!f) { console.error('未找到: ' + p); process.exit(1); }
  const s = baseOffset + parseInt(f.offset, 10);
  process.stdout.write(buf.slice(s, s + f.size));
  process.exit(0);
}

if (mode === 'find') {
  const kw = process.argv[3] || '';
  let hits = 0;
  for (const f of files) {
    if (!/\.(js|json|ts|css|html)$/.test(f.file)) continue;
    if (f.size > 40 * 1024 * 1024) continue;
    const start = baseOffset + parseInt(f.offset, 10);
    const text = buf.slice(start, start + f.size).toString('utf8');
    let idx = 0, count = 0;
    const lower = kw.toLowerCase(), hay = text.toLowerCase();
    while ((idx = hay.indexOf(lower, idx)) !== -1 && count < 5) {
      const ctx = text.slice(Math.max(0, idx - 300), idx + 400).replace(/\s+/g, ' ');
      console.log(`\n===== ${f.file} @${idx} =====\n...${ctx}...`);
      hits++; count++;
      idx += kw.length;
    }
    if (count >= 5) console.log(`(更多命中已省略: ${f.file})`);
  }
  console.log(`\nTOTAL_HITS=${hits}`);
  process.exit(0);
}
console.log('未知模式');
