import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COST_GUARD_DEFAULTS,
  readCostGuards,
  isWritesEnabled,
  assertCostToken,
  validateSizes,
  projectedUsage,
  exceedsBucketCap,
  verifyActualBytes,
} from './cost.js';
import { buildUploadPlan } from './paths.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const plan = buildUploadPlan('frozen-malice', '02_DM主控台.html', '剧情导图.xmind', [
  'assets/cover.png',
  'assets/maps/深层/地图 01.png',
]);
const goodSizes = () => ({
  '02_DM主控台.html': 2 * MB,
  '剧情导图.xmind': 1 * MB,
  'assets/cover.png': 3 * MB,
  'assets/maps/深层/地图 01.png': 4 * MB,
});

test('默认闸门：50MB 单文件 / 200MB 条目 / 500 文件 / 8GB 桶容量', () => {
  assert.equal(COST_GUARD_DEFAULTS.maxSingleFileBytes, 50 * MB);
  assert.equal(COST_GUARD_DEFAULTS.maxEntryBytes, 200 * MB);
  assert.equal(COST_GUARD_DEFAULTS.maxFilesPerEntry, 500);
  assert.equal(COST_GUARD_DEFAULTS.bucketCapBytes, 8 * GB);
});

test('readCostGuards：从 wrangler vars 读 MB/GB，非法值回退、超过 10GB 被钳制', () => {
  const g = readCostGuards({
    MAX_SINGLE_FILE_MB: '25',
    MAX_ENTRY_MB: '300',
    MAX_FILES_PER_ENTRY: '120',
    BUCKET_CAP_GB: '9',
  });
  assert.equal(g.maxSingleFileBytes, 25 * MB);
  assert.equal(g.maxEntryBytes, 300 * MB);
  assert.equal(g.maxFilesPerEntry, 120);
  assert.equal(g.bucketCapBytes, 9 * GB);
  assert.deepEqual(
    readCostGuards({ MAX_SINGLE_FILE_MB: 'oops', BUCKET_CAP_GB: '999' }),
    { ...COST_GUARD_DEFAULTS, bucketCapBytes: 10 * GB },
  );
});

test('validateSizes：合法三区输入通过，返回声明总量', () => {
  const r = validateSizes({ sizes: goodSizes(), plan });
  assert.deepEqual(r.errors, []);
  assert.equal(r.declaredTotalBytes, 10 * MB);
});

test('validateSizes：缺某个文件的大小声明 → 拒', () => {
  const sizes = goodSizes();
  delete sizes['assets/cover.png'];
  assert.ok(validateSizes({ sizes, plan }).errors.some((e) => e.includes('assets/cover.png')));
});

test('validateSizes：单文件超 50MB → 拒；条目总量超 200MB → 拒', () => {
  const bigFile = { ...goodSizes(), 'assets/cover.png': 51 * MB };
  assert.ok(validateSizes({ sizes: bigFile, plan }).errors.some((e) => e.includes('单文件')));

  const bigEntry = { ...goodSizes(), 'assets/maps/深层/地图 01.png': 198 * MB };
  assert.ok(validateSizes({ sizes: bigEntry, plan }).errors.some((e) => e.includes('整条目')));
});

test('validateSizes：文件数超上限 → 拒（与 plan 长度一致）', () => {
  const guards = { ...COST_GUARD_DEFAULTS, maxFilesPerEntry: 3 };
  const r = validateSizes({ sizes: goodSizes(), plan, guards });
  assert.ok(r.errors.some((e) => e.includes('单次上架文件数')));
});

test('projectedUsage：同 slug 修订要减掉旧体积，不能重复计', () => {
  const used = 7 * GB;
  const replacing = 1 * GB;
  assert.equal(projectedUsage(used, replacing, 1 * GB), 7 * GB);
  assert.equal(projectedUsage(used, 0, 2 * GB), 9 * GB);
  // 旧值缺失 / 为 0 时不会把 used 减成负数
  assert.equal(projectedUsage(0, 5 * GB, 1 * MB), 1 * MB);
});

test('exceedsBucketCap：等于 cap 放行，超 1 字节就拒', () => {
  assert.equal(exceedsBucketCap(8 * GB, 8 * GB), false);
  assert.equal(exceedsBucketCap(8 * GB + 1, 8 * GB), true);
});

test('先红后绿：把桶容量闸门调大，同一份超限输入就会放行', () => {
  const used = 7.9 * GB;
  const incoming = 0.2 * GB;
  const projected = projectedUsage(used, 0, incoming);
  assert.equal(exceedsBucketCap(projected, 8 * GB), true, '8GB 闸门必须拦住');
  assert.equal(exceedsBucketCap(projected, 10 * GB), false, '闸门回退后断言真的会变绿');
});

test('verifyActualBytes：finalize 用 head().size 复核，少报声明会被抓到', () => {
  const ok = verifyActualBytes({
    actualSizes: [2 * MB, 1 * MB, 3 * MB, 4 * MB],
    declaredTotalBytes: 10 * MB,
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.actualTotalBytes, 10 * MB);

  const lying = verifyActualBytes({
    actualSizes: [2 * MB, 1 * MB, 3 * MB, 250 * MB],
    declaredTotalBytes: 10 * MB,
  });
  assert.ok(lying.errors.some((e) => e.includes('明显大于声明体积')));
  assert.ok(lying.errors.some((e) => e.includes('整条目上限')));
});

// ── fail-closed：宁可停止访问，也不放过一个拿不到可信数字的环节（B1-3 历史教训）──
test('一键熔断：只有显式 WRITES_ENABLED="0" 才关写口，缺省保持启用', () => {
  assert.equal(isWritesEnabled({}), true);
  assert.equal(isWritesEnabled({ WRITES_ENABLED: '1' }), true);
  assert.equal(isWritesEnabled({ WRITES_ENABLED: 'false' }), true);
  assert.equal(isWritesEnabled({ WRITES_ENABLED: '0' }), false);
});

test('令牌完整性：旧版令牌缺成本字段一律拒，不能当作 0 放行', () => {
  const complete = { declaredTotalBytes: 10 * MB, bucketCapBytes: 8 * GB, keys: [], exp: 1 };
  assert.deepEqual(assertCostToken(complete), []);
  assert.ok(assertCostToken({ keys: [], exp: 1 }).length >= 2);
  assert.ok(assertCostToken(null).length >= 1);
  assert.ok(assertCostToken({ declaredTotalBytes: '大', bucketCapBytes: 8 * GB }).length >= 1);
});

test('fail-closed：用量数字不可信时 projectedUsage 返回 Infinity，容量锁必定拦下', () => {
  assert.equal(projectedUsage(undefined, 0, 1 * MB), Number.POSITIVE_INFINITY);
  assert.equal(projectedUsage(7 * GB, NaN, 1 * MB), Number.POSITIVE_INFINITY);
  assert.equal(exceedsBucketCap(Number.POSITIVE_INFINITY, 8 * GB), true);
  assert.equal(exceedsBucketCap(NaN, 8 * GB), true);
  assert.equal(exceedsBucketCap(1 * MB, undefined), true);
});

test('fail-closed：head().size 不可用或声明体积不可信 → 拒写索引，不静默当 0', () => {
  const badSize = verifyActualBytes({
    actualSizes: [1 * MB, undefined, 1 * MB],
    declaredTotalBytes: 3 * MB,
  });
  assert.ok(badSize.errors.some((e) => e.includes('真实大小')));

  const badDeclared = verifyActualBytes({
    actualSizes: [1 * MB, 1 * MB],
    declaredTotalBytes: undefined,
  });
  assert.ok(badDeclared.errors.some((e) => e.includes('声明体积不可信')));
});

test('先红后绿：预留量只增不减，放弃上传后容量锁宁可提前拦死', () => {
  const used = 7.5 * GB;
  const reserved = 0.6 * GB; // 上一次 prepare 签了 URL 但没 finalize，预留永久留下
  assert.equal(exceedsBucketCap(projectedUsage(used + reserved, 0, 0.1 * GB), 8 * GB), true);
  // 若把预留量误当 0（旧版设计），同一份输入会错误放行
  assert.equal(exceedsBucketCap(projectedUsage(used, 0, 0.1 * GB), 8 * GB), false);
});
