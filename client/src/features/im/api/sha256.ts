/**
 * 流式 SHA-256（D25）：WebCrypto subtle 无流式接口，大文件整块 arrayBuffer
 * 会爆内存（旧实现 2GB 视频全量入内存）——本模块按 4MB 切片喂增量摘要。
 * 纯 TS 实现（~100MB/s 档）；Rust 侧原生计算登记 P1（≥64MB 文件再评估）。
 * 正确性经 Node crypto 跨验证（空/边界 55-64-129B/10MB 随机全对齐）。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256Stream {
  private h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private w = new Uint32Array(64);

  update(data: Uint8Array): void {
    this.total += data.length;
    let i = 0;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      i = take;
      if (this.bufLen === 64) {
        this.compress(this.buf, 0);
        this.bufLen = 0;
      }
    }
    for (; i + 64 <= data.length; i += 64) this.compress(data, i);
    if (i < data.length) {
      this.buf.set(data.subarray(i), 0);
      this.bufLen = data.length - i;
    }
  }

  /** 收口：padding + 长度 → hex（调用后实例作废） */
  hex(): string {
    const bl = BigInt(this.total) * 8n;
    const tail = new Uint8Array(((this.bufLen < 56 ? 56 : 120) - this.bufLen) + 8);
    tail[0] = 0x80;
    for (let i = 15; i >= 8; i--) {
      tail[tail.length - 1 - (15 - i)] = Number((bl >> BigInt((15 - i) * 8)) & 0xffn);
    }
    if (this.bufLen > 0) {
      const merged = new Uint8Array(this.bufLen + tail.length);
      merged.set(this.buf.subarray(0, this.bufLen), 0);
      merged.set(tail, this.bufLen);
      this.feedFinal(merged);
    } else {
      this.feedFinal(tail);
    }
    const out: string[] = [];
    for (let i = 0; i < 8; i++) out.push(this.h[i].toString(16).padStart(8, '0'));
    return out.join('');
  }

  /** 尾块按 64 对齐压缩（独立于 update——不计 total） */
  private feedFinal(data: Uint8Array): number {
    let i = 0;
    for (; i + 64 <= data.length; i += 64) this.compress(data, i);
    return i;
  }

  private compress(x: Uint8Array, off: number): void {
    const w = this.w;
    const h = this.h;
    for (let i = 0; i < 16; i++) {
      const j = off + 4 * i;
      w[i] = ((x[j] << 24) | (x[j + 1] << 16) | (x[j + 2] << 8) | x[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
}

/**
 * 文件流式 sha256（hex；4MB 切片增量喂——大文件不再整块入内存）。
 * 逐片 await 让出事件循环（UI 不冻结）。
 */
export async function sha256HexStream(file: Blob, sliceBytes = 4 << 20): Promise<string> {
  const s = new Sha256Stream();
  for (let off = 0; off < file.size; off += sliceBytes) {
    const buf = await file.slice(off, Math.min(off + sliceBytes, file.size)).arrayBuffer();
    s.update(new Uint8Array(buf));
  }
  if (file.size === 0) {
    // 空内容：digest 即空串哈希（循环不进——feedFinal 直接 padding）
  }
  return s.hex();
}
