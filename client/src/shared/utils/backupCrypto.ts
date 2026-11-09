/**
 * 端侧备份加密（OQ-B09 拍板：口令派生+恢复码，跨设备可恢复；08 篇 §5.2 零知识——
 * 服务端只存密文与 envelope，明文/口令/恢复码永不上行）。
 *
 * 方案（Bitwarden 式双层）：
 * - DEK（数据密钥）随机 32B，直接加密事件 JSONL（AES-256-GCM）
 * - 口令/恢复码各经 PBKDF2-SHA256(210k) 派生 KEK，分别 wrap DEK（envelope 双通道）
 * - verifier：DEK 加密固定明文——解包时校验，区分"密钥错"与"数据损坏"
 * - 恢复码 6×4 字符（base32 去混淆字母表，~120bit 熵），仅设置时展示一次
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const PBKDF2_ITERATIONS = 210_000;
const DEK_BITS = 256;
/** 恢复码字母表（去 0/O/1/I 混淆；5bit/字符×24 字符=120bit 熵） */
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const VERIFIER_PLAINTEXT = 'bbw-agent-backup-v1';

/** 密钥信封（随备份行存储；服务端不可解） */
export interface BackupKeyEnvelope {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  /** b64(16B salt) ×2：口令/恢复码各一 */
  saltP: string;
  saltR: string;
  /** b64(12B iv + DEK wrap 密文) ×2 */
  wrappedP: string;
  wrappedR: string;
  /** b64(12B iv + 固定明文密文)：DEK 正确性校验 */
  verifier: string;
}

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** PBKDF2 派生 KEK（口令/恢复码同路径） */
async function deriveKek(secret: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    base,
    { name: 'AES-GCM', length: DEK_BITS },
    false,
    ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt'],
  );
}

/** AES-GCM 加密（iv 12B 前缀密文） */
async function gcmSeal(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, plain as unknown as BufferSource));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return out;
}

/** AES-GCM 解密（剥 iv 前缀）；密钥错/损坏 → reject */
async function gcmOpen(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
  const iv = sealed.slice(0, 12);
  const ct = sealed.slice(12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, ct as unknown as BufferSource));
}

/** DEK → 可导入的原始密钥形态（本机缓存/跨调用传递） */
export type DekMaterial = Uint8Array;

function toDekKey(dek: DekMaterial): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', dek as unknown as BufferSource, { name: 'AES-GCM', length: DEK_BITS }, false, ['encrypt', 'decrypt']);
}

/** 生成恢复码（6 组 4 字符，连字符分组；仅此一次明文存在） */
export function generateRecoveryCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < 6; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += RECOVERY_ALPHABET[randomBytes(1)[0] % RECOVERY_ALPHABET.length];
    groups.push(s);
  }
  return groups.join('-');
}

/** 归一化用户输入的恢复码/口令（恢复码去连字符大写；口令原样） */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[-\s]/g, '').toUpperCase();
}

/** 设置口令 → 生成 envelope + 本机 DEK + 恢复码（一次性） */
export async function createEnvelope(password: string): Promise<{ envelope: BackupKeyEnvelope; dek: DekMaterial; recoveryCode: string }> {
  if (password.length < 8) throw new Error('口令至少 8 个字符');
  const dek = randomBytes(DEK_BITS / 8);
  const saltP = randomBytes(16);
  const saltR = randomBytes(16);
  const recoveryCode = generateRecoveryCode();
  const kekP = await deriveKek(password, saltP, PBKDF2_ITERATIONS);
  const kekR = await deriveKek(normalizeRecoveryCode(recoveryCode), saltR, PBKDF2_ITERATIONS);
  const dekKey = await toDekKey(dek);
  return {
    envelope: {
      v: 1,
      kdf: 'PBKDF2-SHA256',
      iterations: PBKDF2_ITERATIONS,
      saltP: b64(saltP),
      saltR: b64(saltR),
      wrappedP: b64(await gcmSeal(kekP, dek)),
      wrappedR: b64(await gcmSeal(kekR, dek)),
      verifier: b64(await gcmSeal(dekKey, enc.encode(VERIFIER_PLAINTEXT))),
    },
    dek,
    recoveryCode,
  };
}

/** 解包 DEK（口令或恢复码通道；verifier 校验失败=密钥错） */
export async function unwrapDek(envelope: BackupKeyEnvelope, secret: string, channel: 'password' | 'recovery'): Promise<DekMaterial> {
  const salt = unb64(channel === 'password' ? envelope.saltP : envelope.saltR);
  const wrapped = unb64(channel === 'password' ? envelope.wrappedP : envelope.wrappedR);
  const normalized = channel === 'recovery' ? normalizeRecoveryCode(secret) : secret;
  const kek = await deriveKek(normalized, salt, envelope.iterations || PBKDF2_ITERATIONS);
  let dek: Uint8Array;
  try {
    dek = await gcmOpen(kek, wrapped);
  } catch {
    throw new Error(channel === 'password' ? '口令错误' : '恢复码错误');
  }
  // verifier 二次校验（防御 wrap 通道与数据密钥不一致的异常态）
  const dekKey = await toDekKey(dek);
  try {
    const v = await gcmOpen(dekKey, unb64(envelope.verifier));
    if (dec.decode(v) !== VERIFIER_PLAINTEXT) throw new Error('bad verifier');
  } catch {
    throw new Error('密钥校验失败（envelope 损坏）');
  }
  return dek;
}

/** DEK 加密任意 JSON 载荷（备份体） */
export async function encryptJson(dek: DekMaterial, payload: unknown): Promise<Uint8Array> {
  const key = await toDekKey(dek);
  return gcmSeal(key, enc.encode(JSON.stringify(payload)));
}

/** DEK 解密备份体（密钥错/损坏 → reject） */
export async function decryptJson<T>(dek: DekMaterial, sealed: Uint8Array): Promise<T> {
  const key = await toDekKey(dek);
  return JSON.parse(dec.decode(await gcmOpen(key, sealed))) as T;
}

/** 本机受信缓存（DEK+envelope；清缓存/换机后走恢复码） */
const LOCAL_CACHE_KEY = 'bbw.agent-backup.keys';

export interface LocalBackupKeys {
  dek: string; // b64
  envelope: BackupKeyEnvelope;
}

export function saveLocalBackupKeys(keys: LocalBackupKeys): void {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(keys));
  } catch {
    // 隐私模式：静默（下次走恢复码）
  }
}

export function loadLocalBackupKeys(): LocalBackupKeys | null {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    return raw ? (JSON.parse(raw) as LocalBackupKeys) : null;
  } catch {
    return null;
  }
}

export function clearLocalBackupKeys(): void {
  try {
    localStorage.removeItem(LOCAL_CACHE_KEY);
  } catch {
    // ignore
  }
}
