// prepare 校验通过后签发一次性令牌，finalize 必须带它才能写 D1。
// 防止绕过 prepare（枚举 / 重名 / 依赖断言）直接写脏索引。
import type { Env } from './types';

export interface UploadTokenPayload {
  slug: string;
  meta: {
    title: string;
    system: string;
    kind: string;
    status: string;
    summary: string;
    cover: string;
    consoleFile: string;
    mindmapFile: string;
  };
  keys: string[];
  /** prepare 时声明的总体积，finalize 用 head().size 复核（防少报绕过闸门） */
  declaredTotalBytes: number;
  /** prepare 时的桶容量闸门快照，避免两次请求之间改配置绕过 */
  bucketCapBytes: number;
  /** W2-b：prepare 时是否勾选「模组更新」。旧版 / 在途令牌无此字段 → finalize 按 false 处理（fail-safe，不会误开覆盖口子） */
  isUpdate?: boolean;
  /** prepare 时判定的模式；finalize 再判一次，不一致就拒（防两次请求之间被插队） */
  mode?: 'created' | 'updated';
  exp: number;
}

const enc = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  if (!env.UPLOAD_TOKEN_SECRET) throw new Error('UPLOAD_TOKEN_SECRET 未配置');
  return crypto.subtle.importKey(
    'raw',
    enc.encode(env.UPLOAD_TOKEN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signToken(env: Env, payload: UploadTokenPayload): Promise<string> {
  const body = toBase64Url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function verifyToken(env: Env, token: unknown): Promise<UploadTokenPayload | null> {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(env),
      fromBase64Url(sig),
      enc.encode(body),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as UploadTokenPayload;
    if (!payload?.slug || !Array.isArray(payload.keys) || typeof payload.exp !== 'number') return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
