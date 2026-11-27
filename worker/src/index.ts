// trpg-warehouse · 唯一 Worker
// 职责：Access 校验、预签名 PUT、上架前断言、D1 索引读写、GET /api/modules、下载兜底。
// 浏览端静态壳由 Workers Assets 直出；xmind 解析全部发生在访客浏览器（不经过 Worker）。
import { prepareSchema } from './schema';
import { requireAccess, AccessError } from './access';
import { presignPut } from './presign';
import { signToken, verifyToken } from './token';
import { validateMeta } from '../../shared/contract.js';
import { decideUploadMode } from '../../shared/update-mode.js';
import {
  sortAdminRows,
  canPublish,
  canUnpublish,
  matchesDeleteConfirm,
  storageSnapshot,
  slugFromR2Key,
  isOrphanR2Key,
} from '../../shared/admin.js';
import {
  isUnsafeRelativePath,
  findDuplicateNames,
  buildUploadPlan,
  MODULE_KEY_PREFIX,
} from '../../shared/paths.js';
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

      // 所有 API 分支必须 await：否则 handler 里的异步错误会绕过下面的 catch，
      // JSON 500 / 413 / 503 会退化成 Cloudflare 1101 页（影响 #11 / #12 / #15 的报错形态）。
      // 见档案 §0.6「return await 兜底隐患」，W1 跑通后单独修正，不与 #5 混改。
      if (path === '/api/modules' && request.method === 'GET') return await handleModules(env);

      // ── W2-c · 模组管理台（全部在 /api/upload* 这条已受 Access 保护的 path 下）──
      // 全量列表含 draft；上架 / 下架只改 status；删除 / 校准是人触发的一次性写口。
      // 列表只读一张静态快照，绝不在这里翻 R2（用户 R8：数据是静态的，不是每次访问都读取）。
      if (path === '/api/upload/admin/modules' && request.method === 'GET') {
        await requireAccess(request, env);
        return await handleAdminModules(env);
      }
      if (path === '/api/upload/admin/publish' && request.method === 'POST') {
        await requireAccess(request, env);
        return await handleAdminPublish(request, env);
      }
      if (path === '/api/upload/admin/unpublish' && request.method === 'POST') {
        await requireAccess(request, env);
        return await handleAdminUnpublish(request, env);
      }
      if (path === '/api/upload/admin/delete' && request.method === 'POST') {
        await requireAccess(request, env);
        return await handleAdminDelete(request, env);
      }
      if (path === '/api/upload/admin/calibrate' && request.method === 'POST') {
        await requireAccess(request, env);
        return await handleAdminCalibrate(env);
      }

      if (path === '/api/upload/prepare' && request.method === 'POST') {
        await requireAccess(request, env);
        return await handlePrepare(request, env);
      }
      if (path === '/api/upload/finalize' && request.method === 'POST') {
        await requireAccess(request, env);
        return await handleFinalize(request, env);
      }
      if (path === '/api/download' && request.method === 'GET') return await handleDownload(url, env);

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

// 列表接口的 row→DTO 映射唯一出处（D-05）：公开列表与管理台列表字段完全一致，
// 原先各写一份，改一处漏一处是必然事件（原则 4）。baseUrl 现场推导、不落库（原则 6）。
function toModuleDto(row: ModuleRow, base: string) {
  return {
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
    baseUrl: `${base}/${MODULE_KEY_PREFIX}${encodeURIComponent(row.slug)}/`,
    createdAt: row.created_at,
  };
}

// 公开只读列表：draft 不进返回；返回体不含资源包清单（V-04 / V-09）。
async function handleModules(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT slug, title, system, kind, summary, cover, status, console_file, mindmap_file, created_at
     FROM modules WHERE status = 'published'
     ORDER BY created_at DESC, slug ASC`,
  ).all<ModuleRow>();
  const base = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, '');
  const modules = (results ?? []).map((row) => toModuleDto(row, base));
  return json({ modules });
}

// W2-c：受保护全量列表。前台 /api/modules 一个字不改、仍只返 published。
// 排序走 shared/admin.js 唯一口径（体系序 → slug A→Z）；返回体不含资源包清单。
// storage 是「上次校准」留下的静态快照：这里只读一行 D1，不翻 R2、不算用量（用户 R8）。
async function handleAdminModules(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT slug, title, system, kind, summary, cover, status, console_file, mindmap_file, created_at
     FROM modules`,
  ).all<ModuleRow>();
  let snapshotRow: { total_bytes: number; calibrated_at: string } | null = null;
  try {
    snapshotRow = await env.DB.prepare(
      'SELECT total_bytes, calibrated_at FROM admin_storage WHERE id = 1',
    ).first<{ total_bytes: number; calibrated_at: string }>();
  } catch {
    // 还没校准过 → 表尚未建；顶部模块显示「尚未校准」，不阻断列表
    snapshotRow = null;
  }
  const base = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, '');
  const modules = sortAdminRows(results ?? []).map((row) => toModuleDto(row, base));
  return json({ modules, storage: storageSnapshot(snapshotRow) });
}

// D-06：上架 / 下架是同一套「状态迁移」，原先复制粘贴两份（相似度 0.936）。
// 抽成「配置 + 共用实现」：两条写口的 SQL、错误码、文案逐字保留，外部行为不变。
interface StatusTransition {
  action: string;
  can: (status: string) => boolean;
  to: string;
  updateSql: string;
  conflictCode: string;
  conflictMessage: string;
  verifyError: string;
}

const PUBLISH_TRANSITION: StatusTransition = {
  action: '上架',
  can: canPublish,
  to: 'published',
  updateSql: "UPDATE modules SET status = 'published', updated_at = datetime('now') WHERE slug = ? AND status = 'draft'",
  conflictCode: 'ALREADY_PUBLISHED',
  conflictMessage: '只有草稿可以上架；该条目已是已发布状态',
  verifyError: '状态写入校验失败，未确认上架',
};

const UNPUBLISH_TRANSITION: StatusTransition = {
  action: '下架',
  can: canUnpublish,
  to: 'draft',
  updateSql: "UPDATE modules SET status = 'draft', updated_at = datetime('now') WHERE slug = ? AND status = 'published'",
  conflictCode: 'ALREADY_DRAFT',
  conflictMessage: '只有已发布条目可以下架；该条目已是草稿',
  verifyError: '状态写入校验失败，未确认下架',
};

// 写口一律受一键熔断管住（不涉及 R2，但保持「写口统一」口径）；
// 写后读回断言，回执成功 ≠ 状态真的翻了。
async function transitionStatus(
  request: Request,
  env: Env,
  t: StatusTransition,
): Promise<Response> {
  if (!isWritesEnabled(env)) {
    return json(
      { error: `写口已熔断，暂停${t.action}（成本保护）`, code: 'WRITES_DISABLED' },
      503,
    );
  }
  const body = (await request.json().catch(() => null)) as { slug?: string } | null;
  const slug = typeof body?.slug === 'string' ? body.slug : '';
  if (!slug) return json({ error: '缺少 slug', code: 'BAD_REQUEST' }, 400);

  const row = await env.DB.prepare('SELECT status FROM modules WHERE slug = ?')
    .bind(slug)
    .first<{ status: string }>();
  if (!row) return json({ error: '条目不存在', code: 'NOT_FOUND' }, 404);
  // 只接受配置的单一迁移：重复点 / 已发布 / 脏状态一律拒，不静默改写
  if (!t.can(row.status)) {
    return json({ error: t.conflictMessage, code: t.conflictCode }, 409);
  }

  await env.DB.prepare(t.updateSql).bind(slug).run();

  const after = await env.DB.prepare('SELECT status FROM modules WHERE slug = ?')
    .bind(slug)
    .first<{ status: string }>();
  if (!after || after.status !== t.to) {
    return json({ error: t.verifyError, code: 'INDEX_VERIFY_FAILED' }, 500);
  }

  return json({
    ok: true,
    slug,
    status: t.to,
    previousStatus: row.status,
    verified: true,
  });
}

async function handleAdminPublish(request: Request, env: Env): Promise<Response> {
  return await transitionStatus(request, env, PUBLISH_TRANSITION);
}

async function handleAdminUnpublish(request: Request, env: Env): Promise<Response> {
  return await transitionStatus(request, env, UNPUBLISH_TRANSITION);
}

// ── W2-c 第 3 步 · 人触发的一次性 R2 列举 ──────────────────────────────────
// §0.5 禁「自动定时遍历」；用户 R3-4 明确授权「人手动点一次、当场翻一次，绝对可控」。
// 这个 helper 只被 handleAdminDelete / handleAdminCalibrate 调用，绝不出现在
// scheduled / Cron / alarm / setInterval / 每次请求路径里（沙盒有白名单断言）。
interface AdminBucketObject {
  key: string;
  size: number;
}

// 共用 R2（用户 R10）：删除传 `modules/<slug>/`，校准传 `modules/`。
// 两个调用都带前缀，别的项目 / 桶根对象连列表都进不来，更不会被删或算进规模。
async function listAdminBucketObjects(env: Env, prefix: string): Promise<AdminBucketObject[]> {
  const out: AdminBucketObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ASSETS_BUCKET.list({ prefix, limit: 1000, cursor });
    for (const obj of page.objects) out.push({ key: obj.key, size: obj.size });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

// 顶部校准模块要显示「上次校准后的静态值 + 日期」，必须有个地方存快照。
// 用 Worker 在点「校准」时幂等建一张单行表：纯点击部署，不用去 D1 Studio 手跑 SQL。
// 列表接口只读这一行；表不存在（还没校准过）就显示「尚未校准」。
async function ensureAdminStorageTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS admin_storage (
       id            INTEGER PRIMARY KEY CHECK (id = 1),
       total_bytes   INTEGER NOT NULL,
       calibrated_at TEXT NOT NULL
     )`,
  ).run();
}

// W2-c 第 3 步：删除＝资料卡 + 该 slug 的全部 R2 文件一起清掉（不可逆）。
// 用户 R7 定稿：手打 slug 确认、草稿与已发布都要打、先清文件后删卡、失败可重试。
// 删除时不动容量账（R4-5「删除不划账」）：残留预留留给「校准」统一清。
async function handleAdminDelete(request: Request, env: Env): Promise<Response> {
  if (!isWritesEnabled(env)) {
    return json({ error: '写口已熔断，暂停删除（成本保护）', code: 'WRITES_DISABLED' }, 503);
  }
  const body = (await request.json().catch(() => null)) as
    { slug?: string; confirmSlug?: string } | null;
  const slug = typeof body?.slug === 'string' ? body.slug : '';
  if (!slug) return json({ error: '缺少 slug', code: 'BAD_REQUEST' }, 400);
  // 手打确认由 Worker 权威校验：绕过前端直接打接口也挡得住
  if (!matchesDeleteConfirm(slug, body?.confirmSlug)) {
    return json(
      { error: '手打的 slug 与条目不一致，未删除', code: 'CONFIRM_MISMATCH' },
      400,
    );
  }
  const row = await env.DB.prepare('SELECT status FROM modules WHERE slug = ?')
    .bind(slug)
    .first<{ status: string }>();
  if (!row) return json({ error: '条目不存在', code: 'NOT_FOUND' }, 404);

  // ① 先把仓库文件清干净：R2 没有目录对象，只能按前缀列举后逐个删。
  const objects = await listAdminBucketObjects(env, `${MODULE_KEY_PREFIX}${slug}/`);
  let deleted = 0;
  const remaining: string[] = [];
  for (const obj of objects) {
    try {
      await env.ASSETS_BUCKET.delete(obj.key);
      deleted += 1;
    } catch {
      remaining.push(obj.key);
    }
  }
  // ② 中途失败：资料卡保留、管理台还看得见，重试会重新列举、接着删剩下的。
  if (remaining.length) {
    return json(
      {
        ok: false,
        error: '部分文件未删除，资料卡已保留，可重试',
        code: 'PARTIAL_DELETE',
        deleted,
        remaining,
      },
      409,
    );
  }
  // ③ 全部成功后才删资料卡；写后读回断言。
  await env.DB.prepare('DELETE FROM modules WHERE slug = ?').bind(slug).run();
  const after = await env.DB.prepare('SELECT slug FROM modules WHERE slug = ?')
    .bind(slug)
    .first<{ slug: string }>();
  if (after) {
    return json({ error: '资料卡删除校验失败', code: 'INDEX_VERIFY_FAILED' }, 500);
  }

  return json({
    ok: true,
    slug,
    previousStatus: row.status,
    deletedObjects: deleted,
    verified: true,
  });
}

// W2-c 第 3 步：校准＝人点一次、当场翻一次 **modules/ 前缀**，把该前缀下没索引的
// 垃圾对象真删掉，再把账本对齐到清完后的真实占用，最后写静态快照（R8 / R9 / R10）。
// R9：不能把孤儿量记回账本当兜账值 —— 只把账抬高迁就垃圾，R2 一点没变小。
// R10：R2 可能与另一个项目共用 → 列举 / 删除 / 算规模一律只碰 `modules/` 前缀；
//      顶部「仓库规模」与 5GB 容量闸门算的都是**本项目这部分**，不含别的项目对象。
// 顺序：删孤儿 → 对齐账本 → 写快照（「先更新账本值，再更新前端静态值」仍成立）。
async function handleAdminCalibrate(env: Env): Promise<Response> {
  if (!isWritesEnabled(env)) {
    return json({ error: '写口已熔断，暂停校准（成本保护）', code: 'WRITES_DISABLED' }, 503);
  }
  await ensureAdminStorageTable(env);

  // 只翻本项目前缀：共用桶里别的项目对象连列表都进不来（R10）
  const objects = await listAdminBucketObjects(env, MODULE_KEY_PREFIX);
  const { results } = await env.DB.prepare('SELECT slug FROM modules').all<{ slug: string }>();
  const rows = results ?? [];
  const slugs = new Set(rows.map((r) => r.slug));

  // ① 孤儿 = modules/ 前缀下没有现存 slug 索引、前端拉不到的对象
  //    （半途放弃的上传 / 删除残留 / 前缀内格局不合法的散对象）。直接清掉，
  //    不留、也不记回账本。中途失败保留现场，可点重试。
  const orphans = objects.filter((o) => isOrphanR2Key(o.key, slugs));
  let deletedOrphans = 0;
  const remaining: string[] = [];
  for (const obj of orphans) {
    try {
      await env.ASSETS_BUCKET.delete(obj.key);
      deletedOrphans += 1;
    } catch {
      remaining.push(obj.key);
    }
  }
  if (remaining.length) {
    return json(
      {
        ok: false,
        error: '部分无索引对象未删除，本次未改账本，可重试',
        code: 'PARTIAL_CALIBRATE',
        deletedOrphans,
        remaining,
      },
      409,
    );
  }

  // ② 用「清完之后剩下的对象」重算**本项目**真实占用。它们全都能映射到现存 slug，
  //    所以 SUM(modules.total_bytes) 一定 === totalBytes，不需要任何兜账预留。
  //    别的项目对象不在列举范围内，自然不会混进这个数（R10）。
  const survivors = objects.filter((o) => !isOrphanR2Key(o.key, slugs));
  const totalBytes = survivors.reduce((sum, o) => sum + o.size, 0);
  const bySlug = new Map<string, number>();
  for (const obj of survivors) {
    const slug = slugFromR2Key(obj.key);
    if (!slug) continue; // 双保险：无法映射的对象不该留到这一步
    bySlug.set(slug, (bySlug.get(slug) ?? 0) + obj.size);
  }

  // ③ 账本逐条对齐到真实体积（先更新系统里的账本值）
  for (const r of rows) {
    await env.DB.prepare('UPDATE modules SET total_bytes = ? WHERE slug = ?')
      .bind(bySlug.get(r.slug) ?? 0, r.slug)
      .run();
  }
  // 陈旧预留是为这些垃圾记的，垃圾已清 → 全清，不留任何聚合孤儿值。
  const locks = await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_locks')
    .first<{ n: number }>();
  await env.DB.prepare('DELETE FROM upload_locks').run();

  // ④ 写静态快照（再更新前端那份值）：只有手动点校准会更新它，页面访问绝不重算
  const clock = await env.DB.prepare("SELECT datetime('now') AS now")
    .first<{ now: string }>();
  const calibratedAt = clock?.now ?? '';
  await env.DB.prepare(
    `INSERT INTO admin_storage (id, total_bytes, calibrated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       total_bytes = excluded.total_bytes, calibrated_at = excluded.calibrated_at`,
  )
    .bind(totalBytes, calibratedAt)
    .run();

  const check = await env.DB.prepare(
    'SELECT total_bytes, calibrated_at FROM admin_storage WHERE id = 1',
  ).first<{ total_bytes: number; calibrated_at: string }>();
  if (!check || check.total_bytes !== totalBytes) {
    return json({ error: '校准写入校验失败', code: 'INDEX_VERIFY_FAILED' }, 500);
  }

  return json({
    ok: true,
    totalBytes,
    calibratedAt,
    objectCount: survivors.length,
    deletedOrphans,
    clearedLocks: locks?.n ?? 0,
    verified: true,
  });
}

// 上架前权威校验 + 签发预签名 URL。任何一项不过都不写索引。

// D-07：prepare / finalize 的容量聚合 SQL 原先逐字重复，仅 bind 的 slug 来源不同。
// 抽成唯一出处：两条写口同输入同输出；fail-closed 的错误文案不同，仍留在各自调用处。
async function readCapacityUsage(
  env: Env,
  slug: string,
): Promise<{ used: number; replacing: number } | null> {
  const usage = await env.DB.prepare(
    `SELECT
       (SELECT COALESCE(SUM(total_bytes), 0) FROM modules) +
       (SELECT COALESCE(SUM(reserved_bytes), 0) FROM upload_locks) AS used,
       COALESCE((SELECT total_bytes FROM modules WHERE slug = ?), 0) +
       COALESCE((SELECT reserved_bytes FROM upload_locks WHERE slug = ?), 0) AS replacing`,
  )
    .bind(slug, slug)
    .first<{ used: number; replacing: number }>();
  if (!usage || !Number.isSafeInteger(usage.used) || !Number.isSafeInteger(usage.replacing)) {
    return null;
  }
  return usage;
}

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

  // ── W2-b：slug 重名显式更新开关 · Worker 侧权威判定（含 draft）────────────
  // 前端预检只能看到已发布条目（/api/modules 过滤 published），草稿重名必须靠这里。
  // 未勾选而 slug 已存在 → 409 拒绝：索引不变、也不记预留量（不消耗成本闸门额度）。
  // 勾选且已存在 → 才允许覆盖；勾选但不存在 → 正常新建（勾选项只开这一个口子）。
  const existing = await env.DB.prepare(
    'SELECT status FROM modules WHERE slug = ?',
  )
    .bind(meta.slug)
    .first<{ status: string }>();
  const decision = decideUploadMode({ exists: !!existing, isUpdate: meta.isUpdate });
  if (!decision.allowed) {
    return json(
      {
        error: '该 slug 已存在；未勾选「模组更新」时不允许覆盖',
        code: 'SLUG_EXISTS',
        details: [
          `网址代称 ${meta.slug} 已对应一个条目（含 draft）`,
          '若这是修订，请在上传页勾选「模组更新」后重新提交；否则请换一个 slug',
          '不允许修改 slug：如需换名，须删除 D1 条目与 R2 资料后重新上传（W2-c）',
        ],
      },
      409,
    );
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
  const usage = await readCapacityUsage(env, meta.slug);
  // fail-closed：拿不到可信数字就拒，不「算了放行」
  if (!usage) {
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
    isUpdate: meta.isUpdate,
    mode: decision.mode ?? undefined,
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

  // ── W2-b：finalize 再判一次 ────────────────────────────────────────────────
  // prepare→finalize 之间可能有别的条目上架 / 插队，只有「勾选更新 + 库中确实已存在」
  // 才允许走 upsert 的覆盖分支；旧令牌缺 isUpdate 一律按未勾选（fail-safe）。
  const isUpdate = payload.isUpdate === true;
  const existing = await env.DB.prepare(
    'SELECT status FROM modules WHERE slug = ?',
  )
    .bind(payload.slug)
    .first<{ status: string }>();
  const decision = decideUploadMode({ exists: !!existing, isUpdate });
  if (!decision.allowed) {
    return json(
      {
        error: '该 slug 已存在；未勾选「模组更新」时不允许覆盖',
        code: 'SLUG_EXISTS',
        details: [
          '对象已直传但未写索引；预留量按「只增不减」保留，容量锁宁可高估',
          '若这是修订，请在上传页勾选「模组更新」后重新提交',
        ],
      },
      409,
    );
  }
  if (payload.mode && payload.mode !== decision.mode) {
    return json(
      {
        error: '上架模式在 prepare 与 finalize 之间发生变化，拒绝写索引',
        code: 'MODE_CHANGED',
        details: [`prepare=${payload.mode}，finalize=${decision.mode}`],
      },
      409,
    );
  }
  const previousStatus = existing?.status ?? null;

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
  const usage = await readCapacityUsage(env, payload.slug);
  // fail-closed：拿不到可信数字就拒，不「算了放行」
  if (!usage) {
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

  // W2-b：读回校验从 5 个字段扩到全部元数据 —— 覆盖更新时「内容已更新」的 Worker 侧后盾。
  // draft→draft 的更新在浏览端列表不可见，前端无法逐字段比对，只能靠这里兜住。
  const row = await env.DB.prepare(
    'SELECT slug, title, system, kind, summary, cover, status, console_file, mindmap_file, total_bytes FROM modules WHERE slug = ?',
  )
    .bind(payload.slug)
    .first<ModuleRow>();

  if (
    !row ||
    row.title !== m.title ||
    row.system !== m.system ||
    row.kind !== m.kind ||
    row.summary !== m.summary ||
    row.cover !== m.cover ||
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
    mode: decision.mode,
    previousStatus,
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
  const object = await env.ASSETS_BUCKET.get(`${MODULE_KEY_PREFIX}${slug}/${name}`);
  if (!object) return json({ error: '文件不存在', code: 'NOT_FOUND' }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(object.body, { headers });
}
