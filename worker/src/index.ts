// trpg-warehouse · 唯一 Worker
// 职责：Access 校验、预签名 PUT、上架前断言、D1 索引读写、GET /api/modules、下载兜底。
// 浏览端静态壳由 Workers Assets 直出；xmind 解析全部发生在访客浏览器（不经过 Worker）。
import { prepareSchema } from './schema';
import { requireAccess, AccessError } from './access';
import { presignPut } from './presign';
import { signToken, verifyToken } from './token';
import { validateMeta } from '../../shared/contract.js';
import { isUnsafeRelativePath, findDuplicateNames, buildUploadPlan } from '../../shared/paths.js';
import { extractReferences, buildAvailableSet, findMissingDeps } from '../../shared/deps.js';
import type { Env, ModuleRow } from './types';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // 隐藏路径 ≠ 鉴权：/upload 页面本身也要过 Access 断言
      if (path === '/upload' || path === '/upload/' || path.startsWith('/upload/')) {
        await requireAccess(request, env);
        const assetUrl = new URL(request.url);
        if (assetUrl.pathname === '/upload' || assetUrl.pathname === '/upload/') {
          assetUrl.pathname = '/upload/index.html';
        }
        return env.ASSETS.fetch(
          new Request(assetUrl.toString(), {
            method: request.method,
            headers: request.headers,
          }),
        );
      }

      if (path === '/api/modules' && request.method === 'GET') return handleModules(env);

      if (path === '/api/upload/prepare' && request.method === 'POST') {
        await requireAccess(request, env);
        return handlePrepare(request, env);
      }
      if (path === '/api/upload/finalize' && request.method === 'POST') {
        await requireAccess(request, env);
        return handleFinalize(request, env);
      }
      if (path === '/api/download' && request.method === 'GET') return handleDownload(url, env);

      // 首页 / 条目页 / 预览页 / CSS / vendor JS 全部走边缘静态直出
      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof AccessError) {
        return json({ error: err.message, code: 'ACCESS_DENIED' }, err.status);
      }
      console.error('[trpg-warehouse] unhandled', err);
      return json({ error: '服务内部错误' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// 公开只读列表：draft 不进返回；返回体不含资源包清单（V-04 / V-09）。
async function handleModules(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT slug, title, system, kind, summary, cover, status, console_file, mindmap_file, created_at
     FROM modules WHERE status = 'published'
     ORDER BY created_at DESC, slug ASC`,
  ).all<ModuleRow>();
  const base = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, '');
  const modules = (results ?? []).map((row) => ({
    slug: row.slug,
    title: row.title,
    system: row.system,
    kind: row.kind,
    summary: row.summary,
    cover: row.cover,
    status: row.status,
    consoleFile: row.console_file,
    mindmapFile: row.mindmap_file,
    // 资源基址由 slug 推导，不另存一份（原则 6）
    baseUrl: `${base}/modules/${encodeURIComponent(row.slug)}/`,
    createdAt: row.created_at,
  }));
  return json({ modules });
}

// 上架前权威校验 + 签发预签名 URL。任何一项不过都不写索引。
async function handlePrepare(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => null);
  const parsed = prepareSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        error: '元数据不合法',
        code: 'INVALID_META',
        details: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      },
      400,
    );
  }
  const meta = parsed.data;

  // 与上传端预检共用同一份口径（shared/contract.js），不写第二份校验
  const metaErrors = validateMeta(meta);
  if (metaErrors.length) {
    return json({ error: '元数据不合法', code: 'INVALID_META', details: metaErrors }, 400);
  }

  const unsafe = [
    ...[meta.consoleFile, meta.mindmapFile].filter(isUnsafeRelativePath),
    ...meta.relativePaths.filter(isUnsafeRelativePath),
  ];
  if (unsafe.length) {
    return json({ error: '资源路径不安全，拒绝上架', code: 'UNSAFE_PATH', details: unsafe }, 400);
  }

  const conflicts = findDuplicateNames(meta.consoleFile, meta.mindmapFile, meta.relativePaths);
  if (conflicts.length) {
    return json({ error: '文件名冲突，拒绝上架', code: 'DUPLICATE', details: conflicts }, 409);
  }

  // 不预设必备文件名清单：只按主控台实际引用的本地路径逐项求包含
  const refs = extractReferences(meta.consoleHtml);
  const available = buildAvailableSet(meta.consoleFile, meta.mindmapFile, meta.relativePaths);
  const missing = findMissingDeps(refs, available);
  if (missing.length) {
    return json(
      { error: '主控台引用的本地文件缺失，拒绝上架', code: 'MISSING_DEPS', details: missing },
      422,
    );
  }

  const plan = buildUploadPlan(meta.slug, meta.consoleFile, meta.mindmapFile, meta.relativePaths);
  const expires = Math.max(60, Math.min(3600, Number(env.PRESIGN_EXPIRES) || 3600));
  const uploads: Array<{ relativePath: string; key: string; url: string }> = [];
  for (const item of plan) {
    uploads.push({
      relativePath: item.relativePath,
      key: item.key,
      url: await presignPut(env, item.key, expires),
    });
  }

  const token = await signToken(env, {
    slug: meta.slug,
    meta: {
      title: meta.title,
      system: meta.system,
      kind: meta.kind,
      status: meta.status,
      summary: meta.summary,
      cover: meta.cover,
      consoleFile: meta.consoleFile,
      mindmapFile: meta.mindmapFile,
    },
    keys: plan.map((p) => p.key),
    exp: Date.now() + expires * 1000,
  });

  return json({
    slug: meta.slug,
    uploads,
    token,
    checks: {
      localRefs: refs.local.length,
      externalRefs: refs.external.length,
      // §0.6 登记的根相对路径风险：单独回执提示，B1 不擅自改整体路由口径
      rootRelativeRefs: refs.rootRelative,
    },
  });
}

// 追到真实写入：先 head 每个 R2 对象，再 upsert D1，最后写后读回断言。
async function handleFinalize(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { token?: string; slug?: string } | null;
  const payload = await verifyToken(env, body?.token);
  if (!payload) {
    return json({ error: '上架令牌无效或已过期', code: 'INVALID_TOKEN' }, 403);
  }
  if (body?.slug && body.slug !== payload.slug) {
    return json({ error: 'slug 与令牌不一致', code: 'SLUG_MISMATCH' }, 400);
  }

  // 「上传成功」≠「浏览端多了一张卡」：文件没真写进去就不写索引（P-05）
  const missing: string[] = [];
  for (const key of payload.keys) {
    const head = await env.ASSETS_BUCKET.head(key);
    if (!head) missing.push(key);
  }
  if (missing.length) {
    return json(
      { error: '部分文件未写入 R2，索引未更新', code: 'OBJECTS_MISSING', details: missing },
      409,
    );
  }

  const m = payload.meta;
  await env.DB.prepare(
    `INSERT INTO modules
       (slug, title, system, kind, summary, cover, status, console_file, mindmap_file, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(slug) DO UPDATE SET
       title = excluded.title, system = excluded.system, kind = excluded.kind,
       summary = excluded.summary, cover = excluded.cover, status = excluded.status,
       console_file = excluded.console_file, mindmap_file = excluded.mindmap_file,
       updated_at = datetime('now')`,
  )
    .bind(payload.slug, m.title, m.system, m.kind, m.summary, m.cover, m.status, m.consoleFile, m.mindmapFile)
    .run();

  const row = await env.DB.prepare(
    'SELECT slug, status, console_file, mindmap_file FROM modules WHERE slug = ?',
  )
    .bind(payload.slug)
    .first<Pick<ModuleRow, 'slug' | 'status' | 'console_file' | 'mindmap_file'>>();

  if (
    !row ||
    row.status !== m.status ||
    row.console_file !== m.consoleFile ||
    row.mindmap_file !== m.mindmapFile
  ) {
    return json({ error: '索引写入校验失败，未确认上架', code: 'INDEX_VERIFY_FAILED' }, 500);
  }

  return json({
    ok: true,
    slug: payload.slug,
    status: m.status,
    verified: true,
    objectCount: payload.keys.length,
  });
}

// 解析失败时的「下载原文件」兜底：Content-Disposition 触发下载，不留白屏。
async function handleDownload(url: URL, env: Env): Promise<Response> {
  const slug = url.searchParams.get('slug') ?? '';
  const which = url.searchParams.get('file');
  if (!slug || (which !== 'console' && which !== 'mindmap')) {
    return json({ error: '参数不合法', code: 'BAD_REQUEST' }, 400);
  }
  const row = await env.DB.prepare(
    "SELECT console_file, mindmap_file FROM modules WHERE slug = ? AND status = 'published'",
  )
    .bind(slug)
    .first<{ console_file: string; mindmap_file: string }>();
  if (!row) return json({ error: '条目不存在', code: 'NOT_FOUND' }, 404);

  const name = which === 'console' ? row.console_file : row.mindmap_file;
  const object = await env.ASSETS_BUCKET.get(`modules/${slug}/${name}`);
  if (!object) return json({ error: '文件不存在', code: 'NOT_FOUND' }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(object.body, { headers });
}
