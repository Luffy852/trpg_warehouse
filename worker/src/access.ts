// /upload* 与 /api/upload* 的 Access 校验。
// 主防线是 Cloudflare Access 应用（边缘拦截，未登录 403）；
// 这里再验一次 JWT 断言，防止绕过 route 直连 workers.dev（隐藏路径 ≠ 鉴权）。
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './types';

export class AccessError extends Error {
  constructor(message: string, public status = 403) {
    super(message);
  }
}

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function requireAccess(request: Request, env: Env): Promise<void> {
  const token =
    request.headers.get('CF-Access-JWT-Assertion') ?? readCookie(request, 'CF_Authorization');
  if (!token) {
    throw new AccessError('未通过 Cloudflare Access 认证，上传端拒绝访问');
  }
  if (!env.CF_ACCESS_AUD || !env.CF_ACCESS_TEAM_DOMAIN) {
    throw new AccessError('Access 未配置（CF_ACCESS_AUD / CF_ACCESS_TEAM_DOMAIN）', 503);
  }
  const team = env.CF_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
  try {
    await jwtVerify(token, jwks, {
      audience: env.CF_ACCESS_AUD,
      issuer: `https://${team}`,
      algorithms: ['RS256'],
    });
  } catch {
    throw new AccessError('Access 断言无效或已过期');
  }
}
