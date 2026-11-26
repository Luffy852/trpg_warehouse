// 成本控制唯一口径出处：R2 没有原生硬性账单上限，靠「写口闸门 + 累计容量锁 + 一键熔断」把用量压在免费额度内。
// Worker（权威）、上传端（提前反馈）、node:test（断言）共用这一份，不写第二份判定。
// 对应档案 §0.4「成本控制（B1-3）」、§0.5 禁改清单。
//
// 口径来源（Cloudflare 官方）：
//   R2 Free = 10 GB-month 存储 / 100 万次 Class A（PUT、LIST、multipart）/ 1000 万次 Class B（GET、HEAD）；
//   Spend Management 的硬支出上限目前只覆盖 Workers 与 Durable Objects，明确不含 R2。
// 因此：不能靠 Workers 的限额替 R2 兜底，必须在写口自己卡住体积、数量与累计容量。
//
// ★ 设计铁律（来自「定时遍历 alarm 一天烧爆 DO 免费读写」的历史教训）：
//   1. 成本机制本身绝不能引入高频操作：**没有 cron、没有 scheduled/alarm、没有 setInterval、
//      没有每次请求查用量、没有 GraphQL 轮询、没有 R2 list()**。核算只在 prepare / finalize
//      两次写口做 O(1) 的 D1 聚合，写口由 Access 保护且由人触发，天然低频。
//   2. **fail-closed（宁停不烧钱）**：任何环节拿不到可信数字（D1 查询失败、令牌缺字段、
//      head().size 不可用、声明少报）一律拒绝上架，而不是「算了放行」。
//   3. 预留量只增不减：prepare 先在 D1 记一笔 reservation，finalize 成功后才删。
//      上传中途放弃 / finalize 失败 → 预留量永久留下，容量锁宁可提前拦死，也不少算。

const MB = 1024 * 1024;
const GB = 1024 * MB;

// 默认阈值：可在 wrangler.toml 的 [vars] 里改（纯点击改配置，不必改代码）。
// 用户 R10：R2 可能与另一个项目共用 → 本项目 `modules/` 这部分自限 **5 GB**，
// 给另一个项目留额度。注意 R2 Free 的 10 GB-month 是**按整个桶**算的，
// 这个 5 GB 是本项目写口自己记的账本闸门（modules 聚合），不是云端硬隔离；
// 两个项目合起来是否超 10 GB，需要双方各自的限额一起守住。
// 200 MB/条目按「美术资源包」量级取，超过就说明该走别的分发方式，不该塞进公开只读库。
export const COST_GUARD_DEFAULTS = Object.freeze({
  maxSingleFileBytes: 50 * MB,
  maxEntryBytes: 200 * MB,
  maxFilesPerEntry: 500,
  bucketCapBytes: 5 * GB,
});

function positiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * 从 Worker 环境变量读阈值；没配就用默认值。
 * 单位刻意用 MB / GB，方便在 GitHub 网页里直接编辑 wrangler.toml。
 */
export function readCostGuards(vars = {}) {
  return {
    maxSingleFileBytes: positiveInt(vars.MAX_SINGLE_FILE_MB, 50, 1, 512) * MB,
    maxEntryBytes: positiveInt(vars.MAX_ENTRY_MB, 200, 1, 2048) * MB,
    maxFilesPerEntry: positiveInt(vars.MAX_FILES_PER_ENTRY, 500, 1, 2000),
    bucketCapBytes: positiveInt(vars.BUCKET_CAP_GB, 5, 1, 10) * GB,
  };
}

/**
 * 一键熔断开关：wrangler.toml 里 WRITES_ENABLED = "0" → 所有写口立刻 503。
 * 纯点击：GitHub 网页改一个字符 → Commit → Workers Builds 自动部署；没有脚本、没有 Cron。
 * 缺省视为启用（避免忘记配就把站点锁死）；只有显式 "0" 才关。
 */
export function isWritesEnabled(vars = {}) {
  return String(vars.WRITES_ENABLED ?? '1') !== '0';
}

/**
 * 令牌完整性：老版本令牌没有成本字段，绝不能「当作 0 放行」。
 * 这是 fail-closed 的关键一处 —— 拿不到可信数字就拒绝写索引。
 */
export function assertCostToken(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') return ['上架令牌缺失'];
  if (!Number.isSafeInteger(payload.declaredTotalBytes) || payload.declaredTotalBytes < 0) {
    errors.push('令牌缺少可信的 declaredTotalBytes（疑似旧版令牌）');
  }
  if (!Number.isSafeInteger(payload.bucketCapBytes) || payload.bucketCapBytes <= 0) {
    errors.push('令牌缺少可信的 bucketCapBytes（疑似旧版令牌）');
  }
  return errors;
}

/**
 * 校验上传端声明的文件体积。sizes 的 key 必须与上传计划的 relativePath 一一对应。
 * @param {{ sizes: Record<string, number>, plan: Array<{relativePath: string}>, guards?: object }} input
 * @returns {{ errors: string[], declaredTotalBytes: number }}
 */
export function validateSizes({ sizes, plan, guards = COST_GUARD_DEFAULTS }) {
  const errors = [];
  if (!sizes || typeof sizes !== 'object' || Array.isArray(sizes)) {
    return { errors: ['缺少文件大小声明 sizes'], declaredTotalBytes: 0 };
  }
  if (!Array.isArray(plan) || !plan.length) {
    return { errors: ['上传计划为空'], declaredTotalBytes: 0 };
  }
  if (plan.length > guards.maxFilesPerEntry) {
    errors.push(`单次上架文件数 ${plan.length} 超过上限 ${guards.maxFilesPerEntry}`);
  }

  let declaredTotalBytes = 0;
  for (const item of plan) {
    const size = sizes[item.relativePath];
    if (!Number.isSafeInteger(size) || size < 0) {
      errors.push(`缺少或非法的文件大小声明：${item.relativePath}`);
      continue;
    }
    if (size > guards.maxSingleFileBytes) {
      errors.push(
        `单文件 ${item.relativePath} 为 ${(size / 1024 / 1024).toFixed(1)} MB，超过 ${Math.round(guards.maxSingleFileBytes / 1024 / 1024)} MB 上限`,
      );
    }
    declaredTotalBytes += size;
  }
  if (declaredTotalBytes > guards.maxEntryBytes) {
    errors.push(
      `整条目 ${(declaredTotalBytes / 1024 / 1024).toFixed(1)} MB 超过 ${Math.round(guards.maxEntryBytes / 1024 / 1024)} MB 上限`,
    );
  }
  return { errors, declaredTotalBytes };
}

/**
 * 累计容量投影：used = D1 modules.total_bytes 之和 + upload_locks 预留之和。
 * 同 slug 修订 / 重试时减去该 slug 的旧值，不重复计；预留量只增不减（fail-closed）。
 * 任何入参不是可信的非负有限数 → 返回 Infinity，让 exceedsBucketCap 必定拦下。
 */
export function projectedUsage(usedBytes, replacingBytes, incomingBytes) {
  const nums = [usedBytes, replacingBytes, incomingBytes];
  // NaN / undefined / Infinity / 负数都按「不可信」处理 → Infinity，让容量锁必定拦下
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return Number.POSITIVE_INFINITY;
  return Math.max(0, usedBytes - replacingBytes) + incomingBytes;
}

export function exceedsBucketCap(projectedBytes, capBytes) {
  // 用 arguments.length 区分「没传（用默认）」与「显式传了 undefined（不可信）」，
  // 避免默认参数把 undefined 悄悄变成默认闸门（5GB）而放行。
  const cap = arguments.length > 1 ? capBytes : COST_GUARD_DEFAULTS.bucketCapBytes;
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(projectedBytes)) return true;
  return projectedBytes > cap;
}

/** finalize 时用 R2 head() 的真实 size 复核：声明可以少报，真实写入兜不住就是拒。 */
export function verifyActualBytes({ actualSizes, declaredTotalBytes, guards = COST_GUARD_DEFAULTS }) {
  const errors = [];
  if (!Array.isArray(actualSizes) || !actualSizes.length) {
    return { errors: ['没有可用的真实对象大小'], actualTotalBytes: 0 };
  }
  for (let i = 0; i < actualSizes.length; i += 1) {
    if (!Number.isSafeInteger(actualSizes[i]) || actualSizes[i] < 0) {
      errors.push(`第 ${i + 1} 个对象没有可用的真实大小`);
    }
  }
  if (!Number.isSafeInteger(declaredTotalBytes) || declaredTotalBytes < 0) {
    errors.push('声明体积不可信');
  }
  const actualTotalBytes = errors.length
    ? 0
    : actualSizes.reduce((sum, n) => sum + n, 0);
  if (!errors.length) {
    // 允许 1 MB 的元数据/编码误差；超过则视为声明不实
    if (actualTotalBytes > declaredTotalBytes + 1024 * 1024) {
      errors.push('实际写入体积明显大于声明体积，拒绝写索引');
    }
    if (actualTotalBytes > guards.maxEntryBytes) {
      errors.push('实际写入体积超过整条目上限');
    }
  }
  return { errors, actualTotalBytes };
}
