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
import {
  readCostGuards,
  isWritesEnabled,
  assertCostToken,
  validateSizes,
  projectedUsage,
  exceedsBucketCap,
  verifyActualBytes,
} from '../../shared/cost.js';
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
  // 一键熔断（纯点击：GitHub 网页把 WRITES_ENABLED 改成 "0" → Commit 即生效）。
  // 宁可停止上架，也不在额度不明时继续写 R2。
  if (!isWritesEnabled(env)) {
    return json(
      { error: '写口已熔断，暂停上架（成本保护）', code: 'WRITES_DISABLED' },
      503,
    );
  }
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

  // ── 成本闸门 ①：体积 / 文件数 ────────────────────────────────────────────
  // R2 没有原生硬性账单上限，且 Workers Spend Management 明确不含 R2；
  // 所以必须在写口自己卡住，不能指望 Worker 限额替 R2 兜底。
  const guards = readCostGuards(env);
  const sizeCheck = validateSizes({ sizes: meta.sizes, plan, guards });
  if (sizeCheck.errors.length) {
    return json(
      { error: '文件体积或数量超过成本闸门，拒绝上架', code: 'QUOTA_EXCEEDED', details: sizeCheck.errors },
      413,
    );
  }

  // ── 成本闸门 ②：D1 累计容量锁（替代外部 Cron 熔断，纯网页改配置即可调） ──
  // used = 已上架条目真实体积 + 未 finalize 的预留量。预留量只增不减（fail-closed）：
  // 浏览器拿到预签名 URL 后关掉页面 / finalize 失败，R2 里会留下对象但 D1 没有索引，
  // 若不计预留就会少算，容量锁形同虚设。
  // 这条聚合只在写口跑（Access 保护、人触发），不在浏览请求里跑，也不是定时遍历。
  const usage = await env.DB.prepare(
    `SELECT
       (SELECT COALESCE(SUM(total_bytes), 0) FROM modules) +
       (SELECT COALESCE(SUM(reserved_bytes), 0) FROM upload_locks) AS used,
       COALESCE((SELECT total_bytes FROM modules WHERE slug = ?), 0) +
       COALESCE((SELECT reserved_bytes FROM upload_locks WHERE slug = ?), 0) AS replacing`,
  )
    .bind(meta.slug, meta.slug)
    .first<{ used: number; replacing: number }>();
  // fail-closed：拿不到可信数字就拒，不「算了放行」
  if (!usage || !Number.isSafeInteger(usage.used) || !Number.isSafeInteger(usage.replacing)) {
    return json(
      { error: '容量核算不可用，拒绝上架（成本保护）', code: 'USAGE_UNAVAILABLE' },
      503,
    );
  }
  const projected = projectedUsage(
    usage.used,
    usage.replacing,
    sizeCheck.declaredTotalBytes,
  );
  if (exceedsBucketCap(projected, guards.bucketCapBytes)) {
    return json(
      {
        error: '累计容量将超过 R2 免费额度闸门，拒绝上架',
        code: 'BUCKET_CAP_EXCEEDED',
        details: [
          `当前累计 ${(usage.used / 1024 / 1024 / 1024).toFixed(2)} GB（含未 finalize 的预留量），本次 ${(sizeCheck.declaredTotalBytes / 1024 / 1024).toFixed(1)} MB，闸门 ${(guards.bucketCapBytes / 1024 / 1024 / 1024).toFixed(0)} GB`,
          '请先在 R2 Dashboard 清理旧条目 / 残留对象，或在 wrangler.toml 调整 BUCKET_CAP_GB',
        ],
      },
      413,
    );
  }

  // 先记预留，再签 URL：签名过程中途失败也会留下预留量，宁可高估也不少算。
  await env.DB.prepare(
    `INSERT INTO upload_locks (slug, reserved_bytes, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(slug) DO UPDATE SET
       reserved_bytes = excluded.reserved_bytes, updated_at = datetime('now')`,
  )
    .bind(meta.slug, sizeCheck.declaredTotalBytes)
    .run();

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
    declaredTotalBytes: sizeCheck.declaredTotalBytes,
    bucketCapBytes: guards.bucketCapBytes,
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
  // 一键熔断同样管住 finalize：熔断后不允许有在途上架把索引写回来
  if (!isWritesEnabled(env)) {
    return json(
      { error: '写口已熔断，暂停上架（成本保护）', code: 'WRITES_DISABLED' },
      503,
    );
  }
  const body = (await request.json().catch(() => null)) as { token?: string; slug?: string } | null;
  const payload = await verifyToken(env, body?.token);
  if (!payload) {
    return json({ error: '上架令牌无效或已过期', code: 'INVALID_TOKEN' }, 403);
  }
  // fail-closed：旧版令牌 / 被篡改的令牌缺成本字段，一律拒，不「当作 0 放行」
  const tokenErrors = assertCostToken(payload);
  if (tokenErrors.length) {
    return json(
      { error: '上架令牌缺少成本字段，拒绝写索引', code: 'INVALID_COST_TOKEN', details: tokenErrors },
      403,
    );
  }
  if (body?.slug && body.slug !== payload.slug) {
    return json({ error: 'slug 与令牌不一致', code: 'SLUG_MISMATCH' }, 400);
  }

  // 「上传成功」≠「浏览端多了一张卡」：文件没真写进去就不写索引（P-05）
  // 顺便用 R2 的真实 size 复核 prepare 时的声明，防止少报体积绕过成本闸门。
  const missing: string[] = [];
  const actualSizes: number[] = [];
  for (const key of payload.keys) {
    const head = await env.ASSETS_BUCKET.head(key);
    if (!head) missing.push(key);
    // 不做 `Number(head.size) || 0` 的兜底：拿不到可信 size 就让它进 verifyActualBytes 被拒
    else actualSizes.push(head.size as number);
  }
  if (missing.length) {
    return json(
      { error: '部分文件未写入 R2，索引未更新', code: 'OBJECTS_MISSING', details: missing },
      409,
    );
  }

  const guards = readCostGuards(env);
  const actual = verifyActualBytes({
    actualSizes,
    declaredTotalBytes: payload.declaredTotalBytes,
    guards,
  });
  if (actual.errors.length) {
    return json(
      { error: '实际写入体积超过成本闸门，索引未更新', code: 'QUOTA_EXCEEDED', details: actual.errors },
      413,
    );
  }

  // 容量锁二次复核：prepare 到 finalize 之间可能有别的条目上架，用真实字节再算一次。
  // 本 slug 的预留量同时出现在 used 和 replacing 里，正好抵消，不会重复计。
  const usage = await env.DB.prepare(
    `SELECT
       (SELECT COALESCE(SUM(total_bytes), 0) FROM modules) +
       (SELECT COALESCE(SUM(reserved_bytes), 0) FROM upload_locks) AS used,
       COALESCE((SELECT total_bytes FROM modules WHERE slug = ?), 0) +
       COALESCE((SELECT reserved_bytes FROM upload_locks WHERE slug = ?), 0) AS replacing`,
  )
    .bind(payload.slug, payload.slug)
    .first<{ used: number; replacing: number }>();
  if (!usage || !Number.isSafeInteger(usage.used) || !Number.isSafeInteger(usage.replacing)) {
    return json(
      { error: '容量核算不可用，索引未更新（成本保护）', code: 'USAGE_UNAVAILABLE' },
      503,
    );
  }
  const projected = projectedUsage(
    usage.used,
    usage.replacing,
    actual.actualTotalBytes,
  );
  if (!Number.isSafeInteger(payload.bucketCapBytes) || payload.bucketCapBytes <= 0) {
    return json(
      { error: '容量闸门配置不可信，索引未更新', code: 'INVALID_COST_TOKEN' },
      503,
    );
  }
  if (exceedsBucketCap(projected, payload.bucketCapBytes)) {
    return json(
      {
        error: '累计容量已超过 R2 免费额度闸门，索引未更新（对象已写入，请到 R2 Dashboard 清理）',
        code: 'BUCKET_CAP_EXCEEDED',
        details: [`预计累计 ${(projected / 1024 / 1024 / 1024).toFixed(2)} GB`],
      },
      413,
    );
  }

  const m = payload.meta;
  await env.DB.prepare(
    `INSERT INTO modules
       (slug, title, system, kind, summary, cover, status, console_file, mindmap_file,
        total_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(slug) DO UPDATE SET
       title = excluded.title, system = excluded.system, kind = excluded.kind,
       summary = excluded.summary, cover = excluded.cover, status = excluded.status,
       console_file = excluded.console_file, mindmap_file = excluded.mindmap_file,
       total_bytes = excluded.total_bytes, updated_at = datetime('now')`,
  )
    .bind(
      payload.slug,
      m.title,
      m.system,
      m.kind,
      m.summary,
      m.cover,
      m.status,
      m.consoleFile,
      m.mindmapFile,
      actual.actualTotalBytes,
    )
    .run();

  const row = await env.DB.prepare(
    'SELECT slug, status, console_file, mindmap_file, total_bytes FROM modules WHERE slug = ?',
  )
    .bind(payload.slug)
    .first<Pick<ModuleRow, 'slug' | 'status' | 'console_file' | 'mindmap_file' | 'total_bytes'>>();

  if (
    !row ||
    row.status !== m.status ||
    row.console_file !== m.consoleFile ||
    row.mindmap_file !== m.mindmapFile ||
    row.total_bytes !== actual.actualTotalBytes
  ) {
    return json({ error: '索引写入校验失败，未确认上架', code: 'INDEX_VERIFY_FAILED' }, 500);
  }

  // 索引确认无误后才释放预留量；删除失败也只是多算一点（fail-closed 方向），不阻断上架。
  await env.DB.prepare('DELETE FROM upload_locks WHERE slug = ?').bind(payload.slug).run();

  return json({
    ok: true,
    slug: payload.slug,
    status: m.status,
    verified: true,
    objectCount: payload.keys.length,
    totalBytes: actual.actualTotalBytes,
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
