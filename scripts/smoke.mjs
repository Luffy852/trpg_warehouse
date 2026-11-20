// B1 离线冒烟：不需要 Cloudflare 账号 / 不需要真实 .xmind 样本。
// 验证「两单文件 + 含子目录的资源树 → 依赖断言 → R2 key 格局 → 两代 xmind 解析出图」整条数据链路。
// 真机才能验的部分（Access / 预签名 PUT / R2 CORS / 浏览器渲染 / 大包直传）在末尾明确列出。
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { zipSync, unzipSync, strFromU8 } from 'fflate';
import { importXMindFile, convertXmindToMindElixir } from '@mind-elixir/import-xmind';
import { inspectXmind } from '../shared/xmind.js';
import { validateMeta, slugify } from '../shared/contract.js';
import {
  stripTopFolder,
  buildUploadPlan,
  findDuplicateNames,
  isUnsafeRelativePath,
  skipSingleFileDuplicates,
} from '../shared/paths.js';
import { extractReferences, buildAvailableSet, findMissingDeps } from '../shared/deps.js';
import {
  COST_GUARD_DEFAULTS,
  readCostGuards,
  isWritesEnabled,
  assertCostToken,
  validateSizes,
  projectedUsage,
  exceedsBucketCap,
  verifyActualBytes,
} from '../shared/cost.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const enc = new TextEncoder();
const S = (s) => enc.encode(s);
const results = [];
const check = (name, fn) => {
  fn();
  results.push(name);
  console.log(`  ✓ ${name}`);
};

console.log('=== B1 离线冒烟（沙盒已验）===\n');

// ---------- 1. 元数据与枚举 ----------
const meta = {
  title: '封冻恶疾',
  slug: 'frozen-malice',
  system: 'dnd',
  kind: 'module',
  status: 'published',
  summary: '一次寒夜里的调查',
  cover: 'assets/cover.png',
};
check('slug 由英文小写短横线生成；纯中文标题要求人工填 slug', () => {
  assert.equal(slugify('Death Mines: The Lost Vault!'), 'death-mines-the-lost-vault');
  assert.equal(slugify('封冻恶疾'), '');
  assert.deepEqual(validateMeta(meta), []);
});
check('非法 system / kind / status 被拒', () => {
  assert.equal(validateMeta({ ...meta, system: 'dnd5e', kind: 'series', status: 'live' }).length, 3);
});

// ---------- 2. 三区输入 → R2 key 格局 ----------
const consoleFile = '02_DM主控台.html';
const mindmapFile = '剧情导图.xmind';
// 模拟用户拖入顶层文件夹「资源包」后的 webkitRelativePath，剥顶层后挂到 slug 根
const selected = [
  '资源包/原文.html',
  '资源包/source/第二章.html',
  '资源包/assets/maps/地图 01.png',
  '资源包/assets/maps/深层/隐藏地图#2.png',
  '资源包/assets/cover.png',
];
const tree = selected.map((p) => stripTopFolder(p, '资源包'));

check('拖拽树剥掉顶层文件夹名、≥2 层子目录完整保留', () => {
  assert.deepEqual(tree, [
    '原文.html',
    'source/第二章.html',
    'assets/maps/地图 01.png',
    'assets/maps/深层/隐藏地图#2.png',
    'assets/cover.png',
  ]);
});
check('中文 / 特殊字符路径合法；.. 与根绝对路径被判不安全', () => {
  assert.equal(isUnsafeRelativePath('assets/maps/深层/隐藏地图#2.png'), false);
  assert.equal(isUnsafeRelativePath('../a.png'), true);
  assert.equal(isUnsafeRelativePath('/assets/a.png'), true);
});

const plan = buildUploadPlan(meta.slug, consoleFile, mindmapFile, tree);
check('两单文件平铺条目根；资源树按原结构挂在根下，顶层名不挂成额外一层', () => {
  assert.deepEqual(plan.map((p) => p.key), [
    'modules/frozen-malice/02_DM主控台.html',
    'modules/frozen-malice/剧情导图.xmind',
    'modules/frozen-malice/原文.html',
    'modules/frozen-malice/source/第二章.html',
    'modules/frozen-malice/assets/maps/地图 01.png',
    'modules/frozen-malice/assets/maps/深层/隐藏地图#2.png',
    'modules/frozen-malice/assets/cover.png',
  ]);
  assert.ok(!plan.some((p) => p.key.includes('/资源包/')));
});
check('无重名；两单文件同名或单文件命中拖拽树 → 拒', () => {
  assert.deepEqual(findDuplicateNames(consoleFile, mindmapFile, tree), []);
  assert.ok(findDuplicateNames('同一个.html', '同一个.html', tree).length > 0);
  assert.ok(findDuplicateNames('02_DM主控台.html', mindmapFile, ['02_DM主控台.html']).length > 0);
});

// ---------- 2b. 单文件同名显式跳过（包①b）：最外层总文件夹一次也能上传 ----------
// 真机第二张截图：资源树里天然带着 ①②区已选的两个单文件，按「重名即拒」永远传不上去。
const rootWithSingles = [
  mindmapFile,
  consoleFile,
  'maps/map1_dm.jpg',
  'maps/map1_player.jpg',
  '模组原文/魔兽世界 - 死亡矿井.html',
];
check('单文件同名显式跳过：跳过 2 个冗余副本，保留带前缀引用，重名与缺依赖都清空', () => {
  const { kept, skipped } = skipSingleFileDuplicates(consoleFile, mindmapFile, rootWithSingles);
  assert.deepEqual(skipped.sort(), [mindmapFile, consoleFile].sort());
  assert.deepEqual(kept, [
    'maps/map1_dm.jpg',
    'maps/map1_player.jpg',
    '模组原文/魔兽世界 - 死亡矿井.html',
  ]);
  assert.deepEqual(findDuplicateNames(consoleFile, mindmapFile, kept), []);
  const plan = buildUploadPlan(meta.slug, consoleFile, mindmapFile, kept);
  assert.equal(plan.length, 5);
  assert.equal(new Set(plan.map((p) => p.relativePath)).size, plan.length);
  // 跳过之后仍能命中主控台里带子目录前缀的真实引用
  const refs = extractReferences('<a href="模组原文/魔兽世界 - 死亡矿井.html"></a>');
  assert.deepEqual(
    findMissingDeps(refs, buildAvailableSet(consoleFile, mindmapFile, kept)),
    [],
  );
});
check('防误伤：跳过只针对两单文件同名，树内自身重名仍被拒绝', () => {
  const rels = [consoleFile, 'maps/a.png', 'maps/a.png'];
  const { kept } = skipSingleFileDuplicates(consoleFile, mindmapFile, rels);
  assert.deepEqual(kept, ['maps/a.png', 'maps/a.png']);
  assert.ok(
    findDuplicateNames(consoleFile, mindmapFile, kept)
      .some((x) => x.includes('拖拽树内重名')),
  );
});

// ---------- 3. 按主控台实际引用逐项断言（不预设必备文件名清单） ----------
const consoleHtml = `
<!doctype html><html><body>
  <a href="原文.html">原文（单文件）</a>
  <a href="./source/第二章.html">多文件原文</a>
  <img src="assets/maps/地图 01.png">
  <iframe src="assets/maps/深层/隐藏地图%232.png#top"></iframe>
  <script src="assets/app.js"></script>
  <img src="https://media.dndbeyond.com/avatars/1.png">
  <a href="#chapter1">页内锚点</a>
</body></html>`;
const refs = extractReferences(consoleHtml);
check('主控台本地引用归一化；绝对外链 / 锚点不纳入存在性断言', () => {
  assert.deepEqual(refs.local.sort(), [
    'assets/app.js',
    'assets/maps/地图 01.png',
    'assets/maps/深层/隐藏地图#2.png',
    'source/第二章.html',
    '原文.html',
  ].sort());
  assert.equal(refs.external.length, 1);
  assert.equal(refs.rootRelative.length, 0);
});

// 补上主控台引用到的 assets/app.js，并留一个未被引用文件（验证不拦）
const fullTree = [...tree, 'assets/app.js', '未被引用的废图.png'];
const available = buildAvailableSet(consoleFile, mindmapFile, fullTree);
check('原文单文件 / 多文件两种形态都能过；树内多余未被引用文件不拦', () => {
  assert.deepEqual(findMissingDeps(refs, available), []);
});
check('先红后绿：删掉一个被引用文件，断言真的会红', () => {
  const broken = buildAvailableSet(
    consoleFile,
    mindmapFile,
    fullTree.filter((p) => p !== 'assets/maps/地图 01.png'),
  );
  assert.deepEqual(findMissingDeps(refs, broken), ['assets/maps/地图 01.png']);
});

// ---------- 4. 两代 .xmind 格式（合成样本，不依赖真实文件） ----------
const MODERN_JSON = JSON.stringify([
  {
    id: 'sheet-1',
    title: '主画布',
    rootTopic: {
      id: 'root',
      title: '封冻恶疾',
      children: { attached: [{ id: 'a', title: '第一幕 · 雪夜' }, { id: 'b', title: '第二幕 · 地窖' }] },
    },
  },
  {
    id: 'sheet-2',
    title: 'NPC 关系',
    rootTopic: { id: 'r2', title: '人物', children: { attached: [{ id: 'c', title: '镇长' }] } },
  },
]);
const UPGRADE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<xmap-content><sheet id="s"><topic id="t"><title>Please update XMind to open this file</title></topic></sheet></xmap-content>`;
const XMIND8_XML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" version="2.0">
  <sheet id="s1"><title>Sheet 1</title>
    <topic id="root"><title>冰封恶疾</title>
      <children><topics type="attached">
        <topic id="n1"><title>第一幕</title></topic>
        <topic id="n2"><title>第二幕</title></topic>
      </topics></children>
    </topic>
  </sheet>
</xmap-content>`;

const modernZip = zipSync({
  'content.json': S(MODERN_JSON),
  // 现代文件里也带一个只提示升级的占位 content.xml —— 必须忽略它
  'content.xml': S(UPGRADE_XML),
  'metadata.json': S('{}'),
});
const legacyZip = zipSync({ 'content.xml': S(XMIND8_XML), 'META-INF/manifest.xml': S('<manifest/>') });

// 库内部会打印 ZIP 对象，冒烟输出保持干净
const originalLog = console.log;
async function parse(file) {
  console.log = () => {};
  try {
    return await importXMindFile(file);
  } finally {
    console.log = originalLog;
  }
}

check('现代 XMind：有 content.json 优先，占位 content.xml 不导致空图', () => {
  const entries = unzipSync(modernZip);
  assert.equal(inspectXmind(entries).format, 'json');
  assert.equal(strFromU8(entries['content.json']), MODERN_JSON);
});
const modernSheets = await parse(new File([modernZip], '剧情导图.xmind'));
check('现代 XMind 解析出 2 个 sheet，节点标题可读、可转 mind-elixir 数据', () => {
  assert.equal(modernSheets.length, 2);
  assert.equal(modernSheets[0].rootTopic.title, '封冻恶疾');
  const data = convertXmindToMindElixir(modernSheets[0]);
  assert.equal(data.nodeData.topic, '封冻恶疾');
  assert.equal(data.nodeData.children.length, 2);
  assert.equal(convertXmindToMindElixir(modernSheets[1]).nodeData.topic, '人物');
});

check('XMind 8：无 content.json 时回退 content.xml，且判为旧格式', () => {
  assert.equal(inspectXmind(unzipSync(legacyZip)).format, 'xml');
});
const legacySheets = await parse(new File([legacyZip], '旧版导图.xmind'));
check('XMind 8 解析出图，根节点与子节点可读', () => {
  assert.equal(legacySheets.length, 1);
  assert.equal(legacySheets[0].rootTopic.title, '冰封恶疾');
  const data = convertXmindToMindElixir(legacySheets[0]);
  assert.equal(data.nodeData.topic, '冰封恶疾');
  assert.equal(data.nodeData.children.length, 2);
});
check('损坏 / 占位 / 非 xmind 文件 → 可见拒绝，不留空图', () => {
  assert.equal(inspectXmind(unzipSync(zipSync({ 'content.xml': S(UPGRADE_XML) }))).ok, false);
  assert.equal(inspectXmind(unzipSync(zipSync({ 'a.txt': S('hello') }))).ok, false);
  assert.throws(() => unzipSync(new Uint8Array([1, 2, 3, 4])));
});

// ---------- 5. 成本闸门（B1-3）：R2 无原生硬账单上限，写口自己卡 ----------
const MB_UNIT = 1024 * 1024;
const GB_UNIT = 1024 * MB_UNIT;
const costSizes = {
  '02_DM主控台.html': 2 * MB_UNIT,
  '剧情导图.xmind': 1 * MB_UNIT,
  '原文.html': 1 * MB_UNIT,
  'source/第二章.html': 1 * MB_UNIT,
  'assets/maps/地图 01.png': 3 * MB_UNIT,
  'assets/maps/深层/隐藏地图#2.png': 4 * MB_UNIT,
  'assets/cover.png': 2 * MB_UNIT,
  '未被引用的废图.png': 1 * MB_UNIT,
  'assets/app.js': 1 * MB_UNIT,
};
const costPlan = buildUploadPlan(meta.slug, consoleFile, mindmapFile, fullTree);
check('成本闸门：三区输入 → 体积声明 → 单文件/整条目/文件数校验通过', () => {
  const r = validateSizes({ sizes: costSizes, plan: costPlan, guards: COST_GUARD_DEFAULTS });
  assert.deepEqual(r.errors, []);
  assert.equal(r.declaredTotalBytes, 16 * MB_UNIT);
});
check('成本闸门：D1 累计容量锁把用量压在 8GB 内；同 slug 修订不重复计', () => {
  const projected = projectedUsage(7.9 * GB_UNIT, 0.5 * GB_UNIT, 0.2 * GB_UNIT);
  assert.equal(exceedsBucketCap(projected, COST_GUARD_DEFAULTS.bucketCapBytes), false);
  assert.equal(exceedsBucketCap(projectedUsage(7.9 * GB_UNIT, 0, 0.2 * GB_UNIT), 8 * GB_UNIT), true);
});
check('先红后绿：把闸门调大（或声明少报）后，同一份超限输入会被放行 / 被 finalize 抓到', () => {
  const loose = readCostGuards({ BUCKET_CAP_GB: '10' });
  assert.equal(exceedsBucketCap(8.5 * GB_UNIT, loose.bucketCapBytes), false);
  const lying = verifyActualBytes({
    actualSizes: [2 * MB_UNIT, 1 * MB_UNIT, 250 * MB_UNIT],
    declaredTotalBytes: 3 * MB_UNIT,
  });
  assert.ok(lying.errors.length >= 2, '真实 size 复核必须拦住少报声明');
});
check('成本闸门：单文件超 50MB / 整条目超 200MB → 拒上架', () => {
  const big = { ...costSizes, 'assets/cover.png': 51 * MB_UNIT };
  assert.ok(validateSizes({ sizes: big, plan: costPlan }).errors.some((e) => e.includes('单文件')));
  const huge = { ...costSizes, 'assets/cover.png': 250 * MB_UNIT };
  assert.ok(validateSizes({ sizes: huge, plan: costPlan }).errors.some((e) => e.includes('整条目')));
});
check('一键熔断：WRITES_ENABLED="0" 关写口，缺省启用', () => {
  assert.equal(isWritesEnabled({}), true);
  assert.equal(isWritesEnabled({ WRITES_ENABLED: '0' }), false);
});
check('fail-closed：旧版令牌 / 不可信用量 / 不可信 size 一律拒，不静默放行', () => {
  assert.ok(assertCostToken({ keys: [], exp: 1 }).length >= 2);
  assert.equal(exceedsBucketCap(projectedUsage(undefined, 0, 1 * MB_UNIT), 8 * GB_UNIT), true);
  assert.ok(
    verifyActualBytes({ actualSizes: [1 * MB_UNIT, undefined], declaredTotalBytes: 2 * MB_UNIT })
      .errors.length >= 1,
  );
});
check('预留量只增不减：放弃上传留下的预留会提前拦死容量锁', () => {
  const used = 7.5 * GB_UNIT;
  const reserved = 0.6 * GB_UNIT;
  assert.equal(exceedsBucketCap(projectedUsage(used + reserved, 0, 0.1 * GB_UNIT), 8 * GB_UNIT), true);
  assert.equal(exceedsBucketCap(projectedUsage(used, 0, 0.1 * GB_UNIT), 8 * GB_UNIT), false);
});
check('反模式静态审计：成本机制不含 cron / alarm / setInterval / GraphQL / list() 遍历', () => {
  const dirs = [join(ROOT, 'worker/src'), join(ROOT, 'shared'), join(ROOT, 'web/assets'), join(ROOT, 'scripts')];
  const forbidden = /setInterval\(|async scheduled\(|Cron Trigger|\balarm\b|GraphQL|\.list\(/;
  const hits = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (!/\.(ts|js|mjs)$/.test(name)) continue;
      // 审计脚本自身含这些关键字的字面量；且它只在沙盒跑，不部署，不参与成本路径
      if (name === 'smoke.mjs') continue;
      const text = readFileSync(join(dir, name), 'utf8');
      // 只把「代码行」算命中；注释里说明这些词是允许的
      for (const line of text.split('\n')) {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
        if (forbidden.test(code)) hits.push(`${name}: ${code.slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(hits, [], `发现定时/遍历反模式：\n${hits.join('\n')}`);
});
check('迁移与部署指引都包含 upload_locks 预留量表（纯点击建表不漏项）', () => {
  const sql = readFileSync(join(ROOT, 'migrations/0001_init.sql'), 'utf8');
  const guide = readFileSync(join(ROOT, 'docs/部署指引_纯点击.md'), 'utf8');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS upload_locks'));
  assert.ok(sql.includes('total_bytes'));
  assert.ok(guide.includes('CREATE TABLE IF NOT EXISTS upload_locks'));
  assert.ok(guide.includes('WRITES_ENABLED'));
});

// ---------- 汇总 ----------
console.log(`\n=== 通过 ${results.length} 项断言 ===`);
console.log(`
沙盒已验：
  · 55 条单元测试（契约 / 路径 / 依赖解析 / 单文件同名显式跳过 / xmind 格式判定 / 成本闸门 / fail-closed / 一键熔断）
  · 本冒烟 ${results.length} 项：三区输入 → 剥顶层 → R2 key 格局 → 单文件同名显式跳过 → 依赖逐项断言 → 两代 xmind 出图 → 成本闸门 → 反模式静态审计
  · Worker TypeScript 类型检查、Worker bundle 体积、前端 vendor 产物语法

只能真机 / 用户本地验（见档案 §0.6）：
  · Cloudflare Access 未登录 403、预签名 PUT 直传大包、R2 自定义域 + CORS GET
  · 完整主控台（CSS 段截断样本未到手）的根相对路径写法与真实资源树
  · 浏览器内 mind-elixir 实际渲染 / 多 sheet 切换 / 中文节点保真度
  · 真实两代 .xmind 样本、加密损坏文件的下载兜底、预览库首屏体积
  · D1 写入后浏览端卡片 +1、draft 隔离、单次上架不触发构建
  · 成本控制真机项：Cache Rules 命中是否真的不回源、WAF 限流/防盗链、Billing 告警、容量闸门 413 回执、一键熔断 503、预留量累积行为
`);
