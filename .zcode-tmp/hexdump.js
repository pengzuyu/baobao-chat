const fs = require('fs');
const buf = fs.readFileSync('/Applications/ZCode.app/Contents/Resources/app.asar').subarray(0, 64);
let hex = '';
for (let i = 0; i < buf.length; i++) {
  hex += buf[i].toString(16).padStart(2, '0') + ' ';
  if ((i + 1) % 16 === 0) hex += '\n';
}
console.log(hex);
for (const off of [0, 4, 8, 12, 16]) console.log(`u32@${off} = ${buf.readUInt32LE(off)}`);
const idx = buf.indexOf(Buffer.from('{"files"'));
console.log('json_start_index_in_first_64 =', idx);
