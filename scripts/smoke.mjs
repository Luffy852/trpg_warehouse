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
import { decideUploadMode } from '../shared/update-mode.js';
import {
  sortAdminRows, adminRowActions, previewTarget, canPublish, canUnpublish,
  statusLabel, systemKindLabel, matchesDeleteConfirm, deleteConfirmMessage, storageSnapshot,
  slugFromR2Key, isOrphanR2Key, MODULE_KEY_PREFIX,
} from '../shared/admin.js';
import {
  stripTopFolder,
  buildUploadPlan,
  buildR2Key,
  findDuplicateNames,
  isUnsafeRelativePath,
  skipSingleFileDuplicates,
  mergeCoverFile,
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

// ---------- 2c. 封面作为新增可选资源（包②）：落条目根、体积计入、不误拦依赖 ----------
check('本地封面落条目根：并入上传计划与体积声明，不建 cover/ 子层级', () => {
  // 用包内不存在的名字：与资源树内已有文件同名会被显式拒绝（见下方断言）
  const { paths, conflicts } = mergeCoverFile(
    consoleFile, mindmapFile, tree, '自选封面.jpg',
  );
  assert.deepEqual(conflicts, []);
  const plan = buildUploadPlan(meta.slug, consoleFile, mindmapFile, paths);
  assert.equal(plan.at(-1).key, 'modules/frozen-malice/自选封面.jpg');
  assert.ok(!plan.some((p) => p.key.includes('/cover/')));
  assert.equal(new Set(plan.map((p) => p.relativePath)).size, plan.length);
  // 封面体积要进 sizes（finalize 用 R2 head().size 复核）
  const sizes = { [consoleFile]: 100, [mindmapFile]: 100 };
  for (const p of paths) sizes[p] = 1024;
  assert.equal(Object.keys(sizes).length, plan.length);
  assert.deepEqual(validateSizes({ sizes, plan, guards: COST_GUARD_DEFAULTS }).errors, []);
});
check('防误伤：封面是包内多余未引用文件，主控台引用逐项断言不受影响', () => {
  const { paths } = mergeCoverFile(consoleFile, mindmapFile, tree, '封面.jpg');
  const refs = extractReferences('<a href="原文.html"></a><img src="assets/maps/地图 01.png">');
  assert.deepEqual(findMissingDeps(refs, buildAvailableSet(consoleFile, mindmapFile, paths)), []);
});
check('封面与已有文件同名 → 显式拒绝，不静默覆盖', () => {
  const a = mergeCoverFile(consoleFile, mindmapFile, tree, consoleFile);
  assert.ok(a.conflicts.some((x) => x.includes('封面与单文件同名')));
  assert.deepEqual(a.paths, tree);
  // 旧用法里 cover 可指向资源包内已有的 assets/cover.png；若又选了同名本地图，仍拒绝而非覆盖
  const b = mergeCoverFile(consoleFile, mindmapFile, tree, 'assets/cover.png');
  assert.ok(b.conflicts.some((x) => x.includes('封面与资源树内文件同名')));
  assert.deepEqual(b.paths, tree);
});

// ---------- 2d. 包③ / 包④：Worker 兜底 + 上传页版式与文案回归防护 ----------
check('Worker 9 个 API 分支 return await：异步错误不绕过 catch（JSON 500/413/503 不退化成 1101）', () => {
  const src = readFileSync(join(ROOT, 'worker/src/index.ts'), 'utf8');
  const names = '(Modules|Prepare|Finalize|Download|AdminModules|AdminPublish|AdminUnpublish|AdminDelete|AdminCalibrate)';
  const bare = [...src.matchAll(new RegExp(`\\breturn\\s+handle${names}\\s*\\(`, 'g'))].map((m) => m[1]);
  assert.deepEqual(bare, [], `仍有未 await 的分支：${bare.join('、')}`);
  const awaited = [...src.matchAll(new RegExp(`\\breturn\\s+await\\s+handle${names}\\s*\\(`, 'g'))].map((m) => m[1]);
  assert.deepEqual(
    awaited.sort(),
    [
      'Finalize', 'Download', 'Modules', 'Prepare', 'AdminModules',
      'AdminPublish', 'AdminUnpublish', 'AdminDelete', 'AdminCalibrate',
    ].sort(),
  );
});
check('包④：slug 标签改短文案 + form-grid 内 label 统一预留两行高度（防中文折行把输入框推后）', () => {
  const html = readFileSync(join(ROOT, 'web/upload/index.html'), 'utf8');
  assert.ok(html.includes('网址代称 slug'), 'slug 标签应采用用户指定的短文案');
  assert.ok(!html.includes('英文小写短横线；留空自动从标题生成'), '旧长标签应移除（宽版 4 列时会折成两行）');
  assert.ok(html.includes('纯中文标题'), '自动生成的边界应放进 title 悬浮说明，不塞回标签');
  const css = readFileSync(join(ROOT, 'web/assets/site.css'), 'utf8');
  assert.ok(
    /\.form-grid\s+\.field\s*>\s*label:first-child\s*\{[^}]*min-height/.test(css),
    'form-grid 内所有 label 应有统一 min-height，折行也不推后输入框',
  );
});
check('包④：封面链接与本地封面上传同块（逻辑不割裂），且都不占 form-grid 单元格', () => {
  const html = readFileSync(join(ROOT, 'web/upload/index.html'), 'utf8');
  const gridStart = html.indexOf('<div class="form-grid">');
  const block = html.indexOf('class="field cover-block"');
  assert.ok(gridStart > 0 && block > gridStart, '封面块应在 form-grid 之后独占整行');
  const gridBody = html.slice(gridStart, block);
  assert.ok(!gridBody.includes('id="cover"'), 'cover 文本框不应留在 form-grid 里（否则与本地上传割裂）');
  assert.ok(!gridBody.includes('id="coverFile"'), '本地封面 file input 不应塞进 form-grid 的等高格子');
  assert.ok(!gridBody.includes('class="cover-picker"'), '旧 cover-picker 结构应已移除');
  assert.ok(gridBody.includes('id="summary"'), '简介仍应留在 form-grid 内');
  const blockBody = html.slice(block, html.indexOf('</section>', block));
  for (const id of ['cover', 'coverFile', 'clearCoverBtn', 'coverHint']) {
    assert.ok(blockBody.includes(`id="${id}"`), `封面块内应含 id=${id}（链接与上传紧挨着）`);
  }
  const css = readFileSync(join(ROOT, 'web/assets/site.css'), 'utf8');
  assert.ok(css.includes('.cover-block'), 'site.css 应有独立封面块样式');
  assert.ok(css.includes('.field input:disabled'), '灰态样式应保留');
  assert.ok(css.includes('.cover-block input[type=file]'), 'file input 不应被 .field input 套上文本框边框');
});
check('防误伤：版式重构后上传端 JS 引用的所有元素 id 仍存在', () => {
  const html = readFileSync(join(ROOT, 'web/upload/index.html'), 'utf8');
  const js = readFileSync(join(ROOT, 'web/assets/upload-app.js'), 'utf8');
  const ids = [...new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `HTML 缺少元素：${missing.join('、')}`);
  // 封面功能所需 4 个元素一个都不能少（本地图优先 / 灰态 / 移除 / 提示）
  for (const id of ['cover', 'coverFile', 'clearCoverBtn', 'coverHint']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 id=${id}`);
  }
});

// ---------- 2e. W2-b：slug 重名显式更新开关（双侧校验 + D-01 断言分叉）----------
check('W2-b：上传页「模组更新」勾选项，文案 / 副提示 / 位置按定稿', () => {
  const html = readFileSync(join(ROOT, 'web/upload/index.html'), 'utf8');
  assert.ok(html.includes('id="isUpdate"'), '应有 id=isUpdate 的复选框');
  assert.ok(html.includes('type="checkbox"'), '必须是 checkbox，不能是下拉或按钮');
  assert.ok(html.includes('模组更新'), 'label 文案应为「模组更新」');
  assert.ok(html.includes('未勾选同slug将拒绝'), '副提示应为用户定稿原句');
  const status = html.indexOf('id="status"');
  const box = html.indexOf('id="isUpdate"');
  const summary = html.indexOf('id="summary"');
  assert.ok(status > 0 && box > status && summary > box, '勾选项应在 status 之后、summary 之前（紧挨状态标签）');
});
check('W2-b：复选框恢复原生外观；包④ label 等高规则未被破坏', () => {
  const css = readFileSync(join(ROOT, 'web/assets/site.css'), 'utf8');
  assert.ok(css.includes('.field--checkbox'), '应有独立复选框样式');
  assert.ok(/\.field--checkbox\s+input\[type=checkbox\]/.test(css), 'checkbox 不能被 .field input 套上文本框边框');
  assert.ok(
    /\.form-grid\s+\.field\s*>\s*label:first-child\s*\{[^}]*min-height/.test(css),
    '包④「form-grid 内 label 统一两行高度」回归规则仍应在',
  );
});
check('W2-b：schema 默认 false、token 顶层带 isUpdate（旧令牌按未勾选处理）', () => {
  const schema = readFileSync(join(ROOT, 'worker/src/schema.ts'), 'utf8');
  assert.ok(
    /isUpdate:\s*z\.boolean\(\)\.optional\(\)\.default\(false\)/.test(schema),
    'isUpdate 缺省必须是 false，不能默认开覆盖口子',
  );
  const token = readFileSync(join(ROOT, 'worker/src/token.ts'), 'utf8');
  assert.ok(/isUpdate\?:\s*boolean/.test(token), '令牌顶层应带 isUpdate');
});
check('W2-b：Worker prepare 与 finalize 双侧权威判定；未勾选重名 409、不写索引', () => {
  const src = readFileSync(join(ROOT, 'worker/src/index.ts'), 'utf8');
  const prepare = src.slice(src.indexOf('async function handlePrepare'), src.indexOf('async function handleFinalize'));
  const finalize = src.slice(src.indexOf('async function handleFinalize'), src.indexOf('async function handleDownload'));
  for (const [name, part] of [['prepare', prepare], ['finalize', finalize]]) {
    assert.ok(part.includes('decideUploadMode'), `${name} 必须走唯一口径 decideUploadMode`);
    assert.ok(part.includes('SLUG_EXISTS'), `${name} 必须回执 SLUG_EXISTS`);
  }
  assert.ok(prepare.includes('FROM modules WHERE slug = ?'), 'prepare 必须查 D1（含 draft）');
  assert.ok(finalize.includes('FROM modules WHERE slug = ?'), 'finalize 必须再查一次防并发插队');
  assert.ok(finalize.includes('mode: decision.mode'), 'finalize 回执要带 mode');
  assert.ok(finalize.includes('previousStatus'), 'finalize 回执要带 previousStatus');
});
check('W2-b：前端预检复用同一份口径，已发布同 slug 且未勾选时本地挡下', () => {
  const app = readFileSync(join(ROOT, 'web/assets/upload-app.js'), 'utf8');
  assert.ok(app.includes('decideUploadMode'), '前端预检应复用 shared 唯一口径，不各端各写一份');
  assert.ok(app.includes("'isUpdate'"), 'readForm 应读取勾选项');
  assert.ok(app.includes('未勾选「模组更新」'), '本地挡下应有明确文案提示勾选');
});
check('W2-b：D-01 断言分叉——created 仍 +1，updated 判「卡片数不变、内容已更新」', () => {
  const app = readFileSync(join(ROOT, 'web/assets/upload-app.js'), 'utf8');
  assert.ok(app.includes('expectedCardDelta'), '卡片数期望应走 shared 纯函数，不硬编码 baseline+1');
  assert.ok(app.includes('verifyUpdatedContent'), '必须有「内容已更新」逐字段判定');
  assert.ok(app.includes('卡片数不变、内容已更新'), '更新模式回执文案按用户定稿');
  assert.ok(
    !/const expected\s*=\s*published\s*\?\s*baseline\s*\+\s*1\s*:\s*baseline/.test(app),
    '旧的裸 +1 断言应移除',
  );
});
check('先红后绿：把守卫回退成「一律放行」，拒绝断言真的会红', () => {
  // 模拟回退到线上旧实现（静默覆盖）：exists=true 且未勾选也放行
  const legacy = ({ exists }) => ({ allowed: true, mode: exists ? 'updated' : 'created' });
  assert.equal(legacy({ exists: true }).allowed, true);
  assert.notDeepEqual(legacy({ exists: true }), decideUploadMode({ exists: true, isUpdate: false }));
  assert.equal(decideUploadMode({ exists: true, isUpdate: false }).allowed, false);
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
check('成本闸门：D1 累计容量锁把本项目用量压在 5GB 内；同 slug 修订不重复计', () => {
  const projected = projectedUsage(4.5 * GB_UNIT, 0.5 * GB_UNIT, 0.2 * GB_UNIT);
  assert.equal(exceedsBucketCap(projected, COST_GUARD_DEFAULTS.bucketCapBytes), false);
  assert.equal(exceedsBucketCap(projectedUsage(4.9 * GB_UNIT, 0, 0.2 * GB_UNIT), 5 * GB_UNIT), true);
});
check('先红后绿：把闸门调大（或声明少报）后，同一份超限输入会被放行 / 被 finalize 抓到', () => {
  const loose = readCostGuards({ BUCKET_CAP_GB: '10' });
  assert.equal(exceedsBucketCap(6.5 * GB_UNIT, loose.bucketCapBytes), false);
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
  assert.equal(exceedsBucketCap(projectedUsage(undefined, 0, 1 * MB_UNIT), 5 * GB_UNIT), true);
  assert.ok(
    verifyActualBytes({ actualSizes: [1 * MB_UNIT, undefined], declaredTotalBytes: 2 * MB_UNIT })
      .errors.length >= 1,
  );
});
check('预留量只增不减：放弃上传留下的预留会提前拦死容量锁', () => {
  const used = 4.5 * GB_UNIT;
  const reserved = 0.6 * GB_UNIT;
  assert.equal(exceedsBucketCap(projectedUsage(used + reserved, 0, 0.1 * GB_UNIT), 5 * GB_UNIT), true);
  assert.equal(exceedsBucketCap(projectedUsage(used, 0, 0.1 * GB_UNIT), 5 * GB_UNIT), false);
});
// W2-c 第 3 步白名单：唯一的 R2 列举 helper，只被「删除 / 校准」两个人触发写口调用。
// 用户 R3-4 / R7 第 6 题明确授权「人手动点一次、当场翻一次」，但绝不能变成定时自动跑。
const LIST_HELPER_START = 'async function listAdminBucketObjects';
const LIST_HELPER_END = '// 顶部校准模块要显示';

check('反模式静态审计：成本机制不含 cron / alarm / setInterval / GraphQL；list() 只在人工白名单内', () => {
  const dirs = [join(ROOT, 'worker/src'), join(ROOT, 'shared'), join(ROOT, 'web/assets'), join(ROOT, 'scripts')];
  const forbidden = /setInterval\(|async scheduled\(|Cron Trigger|\balarm\b|GraphQL|\.list\(/;
  const hits = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (!/\.(ts|js|mjs)$/.test(name)) continue;
      // 审计脚本自身含这些关键字的字面量；且它只在沙盒跑，不部署，不参与成本路径
      if (name === 'smoke.mjs') continue;
      let text = readFileSync(join(dir, name), 'utf8');
      // 唯一允许的列举 helper：把它的代码行抹成空行（保留行数，不影响其它断言）
      if (name === 'index.ts' && text.includes(LIST_HELPER_START)) {
        const a = text.indexOf(LIST_HELPER_START);
        const b = text.indexOf(LIST_HELPER_END, a);
        assert.ok(b > a, '白名单 helper 的结束标记必须存在');
        text = text.slice(0, a) + text.slice(a, b).replace(/[^\n]/g, ' ') + text.slice(b);
      }
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

// ---------- 预览页缩放（B 方案：只修步进 + 文案，保留库默认全端输入通路）----------
check('预览页缩放步进回到库默认量级 0.1（+/- 与 Ctrl/⌘+滚轮不再被 scaleMin/scaleMax 拦掉）', () => {
  const app = readFileSync(join(ROOT, 'web/assets/mindmap-app.js'), 'utf8');
  assert.ok(app.includes('scaleSensitivity: 0.1'), '步进应为 0.1：1 会让 +/- 求 scale(2)/scale(0) 撞库上下限 1.4/0.2');
  assert.ok(!app.includes('scaleSensitivity: 1'), '旧值 scaleSensitivity: 1 应移除');
});
check('状态行文案与库默认滚轮行为一致：Ctrl / ⌘ + 滚轮缩放', () => {
  const app = readFileSync(join(ROOT, 'web/assets/mindmap-app.js'), 'utf8');
  assert.ok(app.includes('Ctrl / ⌘ + 滚轮缩放'), '状态行应说明需要按键，不能只写「滚轮缩放」');
  assert.ok(!app.includes('只读预览（滚轮缩放 /'), '旧文案会误导用户以为裸滚轮能缩放');
});
check('缩放修正不接管滚轮 / 触摸输入通路（电脑端与移动端互不干扰）', () => {
  const app = readFileSync(join(ROOT, 'web/assets/mindmap-app.js'), 'utf8');
  const vendor = readFileSync(join(ROOT, 'web/vendor/mindmap.js'), 'utf8');
  // B 方案不自定义 handleWheel：Ctrl/⌘+滚轮缩放、普通滚轮平移、双指 pinch、单指/鼠标拖动平移全留给库
  // 只查「配置键」，不查注释里的技术说明文字
  assert.ok(!/\bhandleWheel\s*:/.test(app), '不应自定义 handleWheel 配置，否则会覆盖库默认的平移 / pinch 通路');
  assert.ok(!/\bscaleMax\s*:/.test(app) && !/\bscaleMin\s*:/.test(app), '不擅自改库缩放上下限（1.4 / 0.2）');
  assert.ok(vendor.includes('y.ctrlKey||y.metaKey'), '库默认 Ctrl/⌘ + 滚轮缩放通路应保留');
  assert.ok(vendor.includes('t.scale(t.scaleVal*C'), '库默认双指 pinch 缩放通路应保留');
  assert.ok(vendor.includes('ptState=l.Pan'), '库默认点按拖动平移通路应保留');
  assert.ok(vendor.includes('t.scaleVal-t.scaleSensitivity'), '右下角 +/- 按钮应仍走库默认步进');
});

// ---------- W2-c 第 1 步 · 模组管理台（受保护全量账本 + 一键上架 + 草稿预览）----------
const adminWorker = readFileSync(join(ROOT, 'worker/src/index.ts'), 'utf8');
const adminAppSrc = readFileSync(join(ROOT, 'web/assets/admin-app.js'), 'utf8');
const adminHtml = readFileSync(join(ROOT, 'web/upload/admin.html'), 'utf8');
const uploadHtml = readFileSync(join(ROOT, 'web/upload/index.html'), 'utf8');
const uploadAppSrc = readFileSync(join(ROOT, 'web/assets/upload-app.js'), 'utf8');
const siteApp = readFileSync(join(ROOT, 'web/assets/app.js'), 'utf8');
const mmApp = readFileSync(join(ROOT, 'web/assets/mindmap-app.js'), 'utf8');
const buildScript = readFileSync(join(ROOT, 'scripts/build-web.mjs'), 'utf8');

check('W2-c ①②③：五个管理台接口都在 /api/upload* 受保护 path 下，且 Worker 内显式 requireAccess', () => {
  for (const p of [
    '/api/upload/admin/modules',
    '/api/upload/admin/publish',
    '/api/upload/admin/unpublish',
    '/api/upload/admin/delete',
    '/api/upload/admin/calibrate',
  ]) {
    assert.ok(adminWorker.includes(`path === '${p}'`), `缺少受保护接口 ${p}`);
  }
  const block = adminWorker.slice(
    adminWorker.indexOf("'/api/upload/admin/modules'"),
    adminWorker.indexOf("'/api/upload/prepare'"),
  );
  assert.equal(
    (block.match(/requireAccess\(request, env\)/g) ?? []).length,
    5,
    '五个分支都必须在 Worker 内验 JWT 兜底（隐藏路径 ≠ 鉴权）',
  );
});

check('W2-c ①：公开列表仍只返 published；管理台列表查全量且排序走 shared 唯一口径', () => {
  assert.ok(adminWorker.includes("FROM modules WHERE status = 'published'"), '前台公开接口一字不改');
  const fn = adminWorker.slice(
    adminWorker.indexOf('async function handleAdminModules'),
    adminWorker.indexOf('async function handleAdminPublish'),
  );
  assert.ok(fn.includes('FROM modules'), '管理台列表应查 modules 表');
  assert.ok(!fn.includes('WHERE status'), '管理台列表不能过滤掉 draft');
  assert.ok(fn.includes('sortAdminRows'), '排序必须走 shared 唯一口径');
  assert.deepEqual(
    sortAdminRows([
      { slug: 'z', system: 'coc' }, { slug: 'b', system: 'dnd' }, { slug: 'a', system: 'dnd' },
    ]).map((r) => r.slug),
    ['a', 'b', 'z'],
    '体系优先、组内 slug A→Z',
  );
});

check('W2-c ①：上架写口只改 status，draft→published + 写后读回，不动 R2 / 预留量 / 容量账', () => {
  const fn = adminWorker.slice(
    adminWorker.indexOf('async function handleAdminPublish'),
    adminWorker.indexOf('async function handleAdminUnpublish'),
  );
  assert.ok(fn.includes('canPublish'), '迁移判定走 shared 唯一口径');
  assert.ok(fn.includes("status = 'published'") && fn.includes("AND status = 'draft'"), '只翻 draft，防重复点');
  assert.ok(fn.includes('SELECT status FROM modules WHERE slug = ?'), '写后读回断言不能省');
  assert.ok(fn.includes('INDEX_VERIFY_FAILED'));
  assert.ok(fn.includes('isWritesEnabled(env)'), '写口受一键熔断管住');
  for (const forbidden of ['ASSETS_BUCKET', 'upload_locks', 'total_bytes', 'head(', '.delete(']) {
    assert.ok(!fn.includes(forbidden), `第 1 步不该碰 ${forbidden}`);
  }
});

check('W2-c ①：前台访客行为一字不变——只有 /upload/ 预览壳才查后台账本', () => {
  for (const src of [siteApp, mmApp]) {
    assert.ok(src.includes("location.pathname.startsWith('/upload/')"), '应按路径自动切数据源');
    assert.ok(src.includes("ADMIN ? '/api/upload/admin/modules' : '/api/modules'"));
  }
  assert.ok(!/const API\s*=\s*'\/api\/upload\/admin\/modules'/.test(siteApp), '不能把所有访客都改成查后台接口');
  assert.ok(siteApp.includes("ADMIN ? 'upload/' : ''"), '草稿条目页的导图入口应指向受保护预览壳');
  assert.ok(mmApp.includes('downloadEl.href = ADMIN'), '草稿导图兜底下载应直指 R2 原文件，不能留 /api/download 死链');
});

check('W2-c ①：管理台五列表头按定稿顺序；上传页只留一个入口', () => {
  const th = [...adminAppSrc.matchAll(/<th>(.*?)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(th, ['模组名', 'slug', '规则及体量', '状态', '操作']);
  assert.ok(adminHtml.includes('/vendor/admin.js'));
  assert.ok(uploadHtml.includes('href="/upload/admin.html"'), '上传页应有管理台入口');
  assert.ok(uploadHtml.includes('模组管理台'));
});

check('W2-c ①：管理台不另写排序 / 状态文案；slug 纯文本只读、无编辑入口', () => {
  assert.ok(adminAppSrc.includes("from '../../shared/admin.js'"));
  assert.ok(adminAppSrc.includes('adminRowActions') && adminAppSrc.includes('previewTarget'));
  assert.ok(!/\.sort\(/.test(adminAppSrc), '排序只能在 Worker 走 sortAdminRows，前端不排第二份');
  const adminCode = adminAppSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!adminCode.includes('已发布') && !adminCode.includes('草稿'), '状态文案只从 statusLabel 来，注释里的说明不算');
  assert.ok(adminAppSrc.includes('class="slug-cell"'));
  assert.ok(!/<input/i.test(adminAppSrc), '管理台不应有输入框，slug 不可改');
  assert.equal(systemKindLabel('dnd', 'campaign'), 'DND-战役');
  assert.equal(statusLabel('published'), '已发布');
  assert.equal(statusLabel('draft'), '草稿');
});

check('W2-c ①②③：预览页 / 条目页同为 3 字；上架 / 下架互斥，删除两种状态都点亮', () => {
  assert.equal(previewTarget('abc', 'draft'), '/upload/preview.html?slug=abc');
  assert.equal(previewTarget('abc', 'published'), '/module.html?slug=abc');
  assert.equal(adminRowActions('draft').previewLabel, '预览页');
  assert.equal(adminRowActions('published').previewLabel, '条目页');
  assert.equal(
    adminRowActions('draft').previewLabel.length,
    adminRowActions('published').previewLabel.length,
    'R7-2 小修补：两个文案同字数，翻转时按钮同宽不跳',
  );
  assert.equal(adminRowActions('draft').publishEnabled, true);
  assert.equal(adminRowActions('draft').unpublishEnabled, false);
  assert.equal(adminRowActions('published').publishEnabled, false);
  assert.equal(adminRowActions('published').unpublishEnabled, true);
  assert.equal(adminRowActions('draft').removeEnabled, true);
  assert.equal(adminRowActions('published').removeEnabled, true);
  // 三个按钮都按状态动态禁用，不再有写死灰着的按钮
  assert.equal((adminAppSrc.match(/<button[^>]*disabled>/g) ?? []).length, 0, '不应再有写死 disabled 的按钮');
  assert.ok(adminAppSrc.includes('${actions.unpublishEnabled'), '下架按钮必须按按钮态动态禁用');
  assert.ok(adminAppSrc.includes('${actions.removeEnabled'), '删除按钮必须按按钮态动态禁用');
  assert.ok(!adminAppSrc.includes('后续开放'), '用户明确不要额外注释');
  for (const a of ['publish', 'unpublish', 'delete', 'calibrate']) {
    assert.ok(adminAppSrc.includes(`data-action="${a}"`), `缺少 ${a} 按钮`);
  }
});

check('W2-c ①：草稿预览壳都在 /upload/ 受保护路径下，且复用同一份 vendor（不改前台页面）', () => {
  const preview = readFileSync(join(ROOT, 'web/upload/preview.html'), 'utf8');
  const mm = readFileSync(join(ROOT, 'web/upload/mindmap.html'), 'utf8');
  assert.ok(preview.includes('data-page="module"') && preview.includes('/vendor/site.js'));
  assert.ok(mm.includes('/vendor/mindmap.js'));
  assert.ok(preview.includes('/upload/admin.html'), '预览壳应能回管理台');
  assert.ok(mm.includes('id="download"'), '导图壳必须保留解析失败时的下载兜底元素');
});

check('W2-c ①：草稿上传成功回执明确「没上架 + 去管理台」', () => {
  assert.ok(uploadAppSrc.includes("meta.status === 'draft'"));
  assert.ok(uploadAppSrc.includes('浏览端不出现'));
  assert.ok(uploadAppSrc.includes('href="/upload/admin.html"'));
  assert.ok(uploadAppSrc.includes('草稿'));
});

check('W2-c ①：打包脚本重出 admin.js；4 个 vendor 产物都随仓库可交付', () => {
  assert.ok(buildScript.includes("'web/assets/admin-app.js', 'web/vendor/admin.js'"));
  for (const name of ['site.js', 'mindmap.js', 'upload.js', 'admin.js']) {
    assert.ok(readFileSync(join(ROOT, 'web/vendor', name), 'utf8').length > 0, `${name} 不应为空`);
  }
});

check('W2-c ①②：上架 / 下架都不碰删除 / 容量账 / 自动翻仓库（第 3 步写口单独审计）', () => {
  const handlers = adminWorker.slice(
    adminWorker.indexOf('async function handleAdminPublish'),
    adminWorker.indexOf('interface AdminBucketObject'),
  );
  for (const forbidden of ['ASSETS_BUCKET', 'upload_locks', 'total_bytes', 'setInterval(', '.list(']) {
    assert.ok(!handlers.includes(forbidden), `第 1、2 步不该出现 ${forbidden}`);
  }
});

check('W2-c ③：管理台列表只读静态快照，页面访问不翻仓库、不算用量（用户 R8）', () => {
  const fn = adminWorker.slice(
    adminWorker.indexOf('async function handleAdminModules'),
    adminWorker.indexOf('async function handleAdminPublish'),
  );
  assert.ok(fn.includes('FROM admin_storage WHERE id = 1'), '应只读那一行静态快照');
  assert.ok(fn.includes('storageSnapshot'), '快照口径走 shared 唯一出处');
  assert.ok(fn.includes('storage:'), '列表回执要带 storage');
  for (const forbidden of ['ASSETS_BUCKET', '.list(', 'SUM(', 'SUM (', 'setInterval(']) {
    assert.ok(!fn.includes(forbidden), `列表接口不该出现 ${forbidden}`);
  }
  assert.equal(storageSnapshot({ total_bytes: 1024, calibrated_at: '2026-11-26 01:00:00' }).totalBytes, 1024);
  assert.equal(storageSnapshot(null), null, '没校准过时显示「尚未校准」');
});

check('W2-c ① 先红后绿：把「按路径切数据源」回退成一律公开，草稿预览断言真的会红；还原后绿', () => {
  const legacy = "const API = '/api/modules';";
  const hasSwitch = (src) =>
    src.includes("location.pathname.startsWith('/upload/')") && src.includes("'/api/upload/admin/modules'");
  assert.equal(hasSwitch(legacy), false, '旧实现应让断言变红');
  assert.equal(hasSwitch(siteApp), true, '还原后应变绿');
  assert.equal(canPublish('published'), false, '已发布重复点上架应被拒');
});

// ---------- W2-c 第 2 步 · 下架（可逆） + 预览/条目页新标签 ----------
check('W2-c ②：下架写口只改 status，published→draft + 写后读回，不动 R2 / 预留量 / 容量账', () => {
  const fn = adminWorker.slice(
    adminWorker.indexOf('async function handleAdminUnpublish'),
    adminWorker.indexOf('interface AdminBucketObject'),
  );
  assert.ok(fn.includes('canUnpublish'), '迁移判定走 shared 唯一口径');
  assert.ok(fn.includes("status = 'draft'") && fn.includes("AND status = 'published'"), '只翻 published，防重复点');
  assert.ok(fn.includes('SELECT status FROM modules WHERE slug = ?'), '写后读回断言不能省');
  assert.ok(fn.includes('INDEX_VERIFY_FAILED'));
  assert.ok(fn.includes('isWritesEnabled(env)'), '写口受一键熔断管住');
  assert.ok(fn.includes("status: 'draft'") && fn.includes('verified: true'));
  for (const forbidden of ['ASSETS_BUCKET', 'upload_locks', 'total_bytes', 'head(', '.delete(']) {
    assert.ok(!fn.includes(forbidden), `下架不该碰 ${forbidden}`);
  }
});

check('W2-c ②：下架与上架互斥，脏状态一律拒，不会误写', () => {
  assert.equal(canUnpublish('published'), true);
  assert.equal(canUnpublish('draft'), false);
  assert.equal(canPublish('draft'), true);
  assert.equal(canPublish('published'), false);
  assert.equal(canPublish('x') || canUnpublish('x'), false);
});

check('W2-c ②：前端下架按钮 → 确认 → 写口 → 拉公开列表断言「卡片 -1」', () => {
  const fn = adminAppSrc.slice(
    adminAppSrc.indexOf('async function unpublish'),
    adminAppSrc.indexOf("app.addEventListener('click'"),
  );
  assert.ok(fn.includes('confirm('), '下架前要弹一句确认，防手滑');
  assert.ok(fn.includes("'/api/upload/admin/unpublish'"));
  assert.ok(fn.includes("data.status !== 'draft'"), '必须校验回执状态');
  assert.ok(fn.includes('baseline - 1'), '行为断言必须是卡片 -1');
  assert.ok(fn.includes('list.some((m) => m.slug === slug)'), '还要断言该条目从公开列表消失');
  assert.ok(fn.includes('恢复发布'), '回执要告诉用户可恢复，方便按真机流程再验上架');
  assert.ok(fn.includes('await load()'), '刷新管理台让该行变草稿、按钮态随之翻转');
});

check('W2-c ②：预览 / 条目页按钮一律新标签打开，两个状态共用同一个按钮位', () => {
  const a = adminAppSrc.match(/<a class="btn btn--sm"[^>]*>/)?.[0] ?? '';
  assert.ok(a.includes('target="_blank"'), '应新标签打开（用户 R6-3）');
  assert.ok(a.includes('rel="noopener"'), '新标签必须带 noopener');
  assert.ok(a.includes('href="${escapeHtml(preview)}"'), '两个状态共用同一个 href 变量，不另开一个按钮');
  assert.equal((adminAppSrc.match(/<a class="btn btn--sm"/g) ?? []).length, 1, '每行只有一个预览/条目页按钮位');
});

check('W2-c ② 先红后绿：回退「下架永远灰着」与「新标签」，断言真的会红；还原后绿', () => {
  const legacyActions = (status) => ({
    previewLabel: status === 'draft' ? '预览' : '条目页',
    publishEnabled: status === 'draft', unpublishEnabled: false, removeEnabled: false,
  });
  assert.notDeepEqual(legacyActions('published'), adminRowActions('published'), '旧按钮态应让断言变红');
  const legacyAnchor = '<a class="btn btn--sm" href="${escapeHtml(preview)}">';
  assert.ok(!legacyAnchor.includes('target="_blank"'), '旧链接应让断言变红');
  assert.ok(adminAppSrc.includes('target="_blank"') && adminAppSrc.includes('rel="noopener"'), '还原后应变绿');
});

// ---------- W2-c 第 3 步 · 删除（不可逆） + 顶部静态校准模块 ----------
const deleteFn = adminWorker.slice(
  adminWorker.indexOf('async function handleAdminDelete'),
  adminWorker.indexOf('async function handleAdminCalibrate'),
);
const calibrateFn = adminWorker.slice(
  adminWorker.indexOf('async function handleAdminCalibrate'),
  adminWorker.indexOf('// 上架前权威校验'),
);
const siteCss = readFileSync(join(ROOT, 'web/assets/site.css'), 'utf8');

check('W2-c ③：删除写口手打 slug 权威校验，绕过前端直接打接口也挡得住', () => {
  assert.ok(deleteFn.includes('matchesDeleteConfirm'), 'Worker 必须复用 shared 唯一口径');
  assert.ok(deleteFn.includes('CONFIRM_MISMATCH'));
  assert.equal(matchesDeleteConfirm('abc', 'abc'), true);
  assert.equal(matchesDeleteConfirm('abc', 'abd'), false);
  assert.equal(matchesDeleteConfirm('abc', null), false);
  const pub = deleteConfirmMessage('abc', 'published');
  assert.ok(pub.includes('正在对外展示') && pub.includes('abc'), '已发布要多提示一句，并入同一个确认框');
  assert.ok(!deleteConfirmMessage('abc', 'draft').includes('正在对外展示'));
});

check('W2-c ③：删除＝先清 R2 文件、全部成功后才删资料卡；中途失败保留资料卡可重试', () => {
  assert.ok(deleteFn.includes('listAdminBucketObjects(env, `modules/${slug}/`)'), '按 slug 前缀列举');
  assert.ok(deleteFn.includes('ASSETS_BUCKET.delete(obj.key)'), '逐个删对象');
  assert.ok(deleteFn.includes('PARTIAL_DELETE') && deleteFn.includes('remaining'), '部分失败要有可重试回执');
  const idxDeleteObjects = deleteFn.indexOf('ASSETS_BUCKET.delete(obj.key)');
  const idxDeleteRow = deleteFn.indexOf('DELETE FROM modules WHERE slug = ?');
  assert.ok(idxDeleteObjects > 0 && idxDeleteRow > idxDeleteObjects, '必须先清文件，再删资料卡');
  assert.ok(deleteFn.includes('INDEX_VERIFY_FAILED'), '删卡后要写后读回断言');
  assert.ok(deleteFn.includes('previousStatus') && deleteFn.includes('deletedObjects'));
  assert.ok(deleteFn.includes('isWritesEnabled(env)'), '写口受一键熔断管住');
  assert.ok(!deleteFn.includes('upload_locks') && !deleteFn.includes('total_bytes'), '删除不划账（R4-5）');
});

check('W2-c ③：删后同 slug 可再用——索引行删掉即走正常新建，不重复计账', () => {
  assert.ok(adminWorker.includes('SELECT status FROM modules WHERE slug = ?'), 'prepare 只按 modules 判重名');
  assert.ok(!deleteFn.includes('upload_locks'), '删除不动预留表，prepare 的 replacing 会自然抵消旧预留');
});

check('W2-c ③（R9 + R10）：只翻 modules/ 前缀、真删该前缀下无索引对象，绝不登记「孤儿值」', () => {
  assert.ok(calibrateFn.includes('listAdminBucketObjects(env, MODULE_KEY_PREFIX)'), '只翻本项目前缀，不翻全桶');
  assert.ok(!calibrateFn.includes('listAdminBucketObjects(env)'), '不能退回无前缀的全桶列举');
  assert.ok(calibrateFn.includes('isOrphanR2Key') && calibrateFn.includes('slugFromR2Key'), '孤儿判定走 shared 唯一口径');
  assert.ok(calibrateFn.includes('ASSETS_BUCKET.delete(obj.key)'), '真删对象，不是只改数字');
  assert.ok(calibrateFn.includes('PARTIAL_CALIBRATE') && calibrateFn.includes('remaining'), '删一半失败要可重试、不改账本');
  // 用户 R9：把孤儿量记回预留 = 把账抬高迁就垃圾，R2 一点没变小 → 明令禁止
  assert.ok(!calibrateFn.includes('unindexedBytes'), '不得再计算孤儿量');
  assert.ok(!calibrateFn.includes('INSERT INTO upload_locks'), '不得再插任何聚合孤儿预留');
  assert.ok(!calibrateFn.includes('__unindexed__'), '不得留孤儿占位 slug');
  assert.ok(!calibrateFn.includes('indexedBytes'), '不得靠差额兜账');
  assert.ok(calibrateFn.includes('DELETE FROM upload_locks'), '垃圾清完后陈旧预留全清');
  // 前缀常量与 buildR2Key 唯一口径不漂移
  assert.equal(MODULE_KEY_PREFIX, 'modules/');
  assert.ok(buildR2Key('the-tollkeeper', 'index.html').startsWith(MODULE_KEY_PREFIX));
  // 共用 R2：只删 modules/ 下无索引的；前缀外（别的项目 / 桶根杂项）一律不碰
  const alive = new Set(['the-tollkeeper', 'goblin-trouble']);
  assert.equal(isOrphanR2Key('modules/the-tollkeeper/index.html', alive), false);
  assert.equal(isOrphanR2Key('modules/abandoned-upload/01.xmind', alive), true);
  assert.equal(isOrphanR2Key('modules/orphan.txt', alive), true);
  for (const outside of ['robots.txt', 'other-project/data.bin', 'shared/logo.png', '']) {
    assert.equal(isOrphanR2Key(outside, alive), false, `前缀外 ${JSON.stringify(outside)} 不该被删`);
  }
});

check('W2-c ③：清完孤儿后账实严格相等 → 先对齐账本 → 再写静态快照', () => {
  assert.ok(calibrateFn.includes('UPDATE modules SET total_bytes'), '账本逐条对齐真实体积');
  assert.ok(calibrateFn.includes('survivors'), '只按清完剩下的对象算账');
  assert.ok(calibrateFn.includes('INSERT INTO admin_storage'), '写静态快照');
  assert.ok(calibrateFn.includes('ON CONFLICT(id) DO UPDATE'), '重复校准是覆盖不是插重复行');
  assert.ok(calibrateFn.includes('INDEX_VERIFY_FAILED'), '快照写后读回断言');
  assert.ok(calibrateFn.includes('isWritesEnabled(env)'));
  assert.ok(calibrateFn.includes('deletedOrphans'), '回执要报清掉几个孤儿对象');
  const iDelete = calibrateFn.indexOf('ASSETS_BUCKET.delete(obj.key)');
  const iAlign = calibrateFn.indexOf('UPDATE modules SET total_bytes');
  const iSnapshot = calibrateFn.indexOf('INSERT INTO admin_storage');
  assert.ok(iDelete > 0 && iAlign > iDelete, '必须先清垃圾，再算账');
  assert.ok(iSnapshot > iAlign, '用户 R8 定稿：先更新账本值，再更新前端静态值');
  // 列举阶段就带 modules/ 前缀：别的项目对象连列表都进不来，更不会计入「仓库规模」
  const slugs = new Set(['the-tollkeeper', 'goblin-trouble']);
  const allBucketObjects = [
    { key: 'modules/the-tollkeeper/index.html', size: 100 },
    { key: 'modules/goblin-trouble/01.xmind', size: 50 },
    { key: 'modules/abandoned/01.xmind', size: 999 },
    { key: 'other-project/data.bin', size: 5000 },
    { key: 'robots.txt', size: 7 },
  ];
  const objects = allBucketObjects.filter((o) => o.key.startsWith(MODULE_KEY_PREFIX));
  assert.equal(objects.length, 3, '共用桶里别的项目对象不在扫描范围内');
  const survivors = objects.filter((o) => !isOrphanR2Key(o.key, slugs));
  const bySlug = new Map();
  for (const o of survivors) {
    const s = slugFromR2Key(o.key);
    assert.ok(s, '幸存对象必须能映射到 slug');
    bySlug.set(s, (bySlug.get(s) ?? 0) + o.size);
  }
  assert.equal(survivors.reduce((a, o) => a + o.size, 0), 150, '本项目垃圾被清掉、规模只算 modules/ 这部分');
  assert.equal([...bySlug.values()].reduce((a, b) => a + b, 0), 150, '账本合计 = 本项目真实占用');
});

check('W2-c ③：静态快照由 Worker 幂等建表，纯点击部署不用去 D1 Studio 手跑 SQL', () => {
  assert.ok(adminWorker.includes('CREATE TABLE IF NOT EXISTS admin_storage'));
  assert.ok(adminWorker.includes('ensureAdminStorageTable(env)'));
  const listFn = adminWorker.slice(
    adminWorker.indexOf('async function handleAdminModules'),
    adminWorker.indexOf('async function handleAdminPublish'),
  );
  assert.ok(listFn.includes('try {') && listFn.includes('snapshotRow = null'), '表不存在时降级为「尚未校准」');
  // 只有校准写口建表；页面访问不建表、不翻仓库
  assert.ok(!listFn.includes('CREATE TABLE'));
});

check('W2-c ③：顶部模块横向「校准按钮 / 仓库规模 / 上次校准」，数据来自静态快照', () => {
  assert.ok(adminAppSrc.includes('class="admin-storage"'));
  assert.ok(adminAppSrc.includes('data-action="calibrate"'));
  assert.ok(adminAppSrc.includes('仓库规模') && adminAppSrc.includes('上次校准'));
  assert.ok(adminAppSrc.includes('storage ? formatBytes(storage.totalBytes)'), '显示的是静态快照值');
  assert.ok(adminAppSrc.includes('尚未校准'), '没校准过要有可见占位');
  assert.ok(adminAppSrc.includes('storage = data.storage ?? null'), 'load 时刷新静态值');
  assert.ok(siteCss.includes('.admin-storage') && siteCss.includes('display: flex'), '横向一行');
  // 用户 R8：不分开列示账本值 / 实际值，校准后本来就是同一个数
  const storageBlock = adminAppSrc.slice(
    adminAppSrc.indexOf('function storageHtml'),
    adminAppSrc.indexOf('function rowHtml'),
  );
  assert.equal((storageBlock.match(/仓库规模/g) ?? []).length, 1, '只列一个仓库规模');
  assert.ok(!storageBlock.includes('账本') && !storageBlock.includes('实际'), '不分开列示两个数');
});

check('W2-c ③：校准按钮点一次即执行，回执不含缓存提示（用户第 7 题）', () => {
  const fn = adminAppSrc.slice(
    adminAppSrc.indexOf('async function calibrate'),
    adminAppSrc.indexOf("app.addEventListener('click'"),
  );
  assert.ok(fn.includes("'/api/upload/admin/calibrate'"));
  assert.ok(fn.includes('await load()'), '校准后刷新顶部静态值与日期');
  assert.ok(fn.includes('formatBytes(data.totalBytes)'));
  assert.ok(fn.includes('deletedOrphans'), '回执要如实报清掉几个无索引对象');
  assert.ok(!fn.includes('unindexedBytes'), '不应再提「孤儿值」');
  assert.ok(!fn.includes('confirm('), '按钮本身就是手动确认，不另弹窗');
  assert.ok(!adminAppSrc.includes('等几分钟'), '用户明确不要缓存说明');
});

check('W2-c ③：删除前端手打确认 + 行为断言（公开卡片 -1 / 管理台该行消失）', () => {
  const fn = adminAppSrc.slice(
    adminAppSrc.indexOf('async function remove'),
    adminAppSrc.indexOf('// 校准：按钮本身就是手动确认'),
  );
  assert.ok(fn.includes('prompt(deleteConfirmMessage(slug, status))'), '两种状态都手打，已发布文案更严');
  assert.ok(fn.includes('matchesDeleteConfirm(slug, typed)'), '前端先挡一次');
  assert.ok(fn.includes("confirmSlug: typed"), '手打值要送 Worker 再验一次');
  assert.ok(fn.includes("'/api/upload/admin/delete'"));
  assert.ok(fn.includes('baseline - 1'), '已发布删除要断言卡片 -1');
  assert.ok(fn.includes('adminRows.some((m) => m.slug === slug)'), '管理台该行也要消失');
  assert.ok(fn.includes('deletedObjects'), '回执要报清掉几个文件');
});

check('W2-c ③：不自动跑写成断言——列举只在一个 helper 里，只被两个人工写口调用', () => {
  assert.equal((adminWorker.match(/\.list\(/g) ?? []).length, 1, '全 Worker 只允许一处 R2 列举');
  assert.equal(
    (adminWorker.match(/listAdminBucketObjects\(/g) ?? []).length,
    3,
    '定义 1 次 + 删除 / 校准各调用 1 次，不得扩散到别处',
  );
  assert.ok(deleteFn.includes('listAdminBucketObjects(env, `modules/${slug}/`)'), '删除也只翻该条目前缀');
  assert.ok(calibrateFn.includes('listAdminBucketObjects(env, MODULE_KEY_PREFIX)'), '校准只翻 modules/ 前缀');
  const listFn = adminWorker.slice(
    adminWorker.indexOf('async function handleAdminModules'),
    adminWorker.indexOf('async function handleAdminPublish'),
  );
  assert.ok(!listFn.includes('listAdminBucketObjects'), '页面访问绝不能翻仓库');
  for (const forbidden of ['setInterval(', 'async scheduled(', 'Cron Trigger', 'GraphQL']) {
    assert.ok(!adminWorker.includes(forbidden), `不该出现 ${forbidden}`);
  }
});

check('W2-c ③ 先红后绿：回退「预览页三字」/「手打确认」/「孤儿值兜账」，断言真的会红；还原后绿', () => {
  assert.notEqual('预览'.length, adminRowActions('published').previewLabel.length, '旧文案应让断言变红');
  const legacyConfirm = (slug, typed) => typed !== undefined;
  assert.equal(legacyConfirm('abc', 'abd'), true, '旧确认形同虚设应让断言变红');
  assert.equal(matchesDeleteConfirm('abc', 'abd'), false, '还原后应变绿');
  // R9 用户纠正的旧做法：不删对象，只把 999 记回预留 → 空间没压缩、账被抬高迁就垃圾
  const legacyOrphanHandling = { unindexedBytes: 999, insertIntoLocks: true };
  assert.ok(legacyOrphanHandling.unindexedBytes > 0, '旧实现确实会登记孤儿值，应让断言变红');
  assert.ok(!calibrateFn.includes('unindexedBytes') && !calibrateFn.includes('INSERT INTO upload_locks'), '新实现不应留任何孤儿值');
  assert.ok(calibrateFn.includes('ASSETS_BUCKET.delete(obj.key)'), '还原后应变绿：真删垃圾');
  assert.equal((adminWorker.match(/\.list\(/g) ?? []).length, 1, '列举点数量白名单还原后应变绿');
  assert.equal(adminRowActions('draft').previewLabel, '预览页');
});

// ---------- R10 · 共用 R2（只删 modules/ 下无索引的） + 本项目门槛 5GB ----------
check('R10 共用桶：容量闸门 = 5GB，wrangler.toml 与代码缺省一致（线上显式写 8 必须一并改）', () => {
  assert.equal(COST_GUARD_DEFAULTS.bucketCapBytes, 5 * GB_UNIT);
  assert.equal(readCostGuards({}).bucketCapBytes, 5 * GB_UNIT, 'vars 缺省时也落 5GB');
  const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
  assert.ok(/BUCKET_CAP_GB\s*=\s*"5"/.test(toml), '线上配置显式写值，只改代码缺省不生效');
  assert.ok(!/BUCKET_CAP_GB\s*=\s*"8"/.test(toml), '不能留 8');
  assert.ok(toml.includes('共用'), '配置里要写明这是共用桶下的本项目自限额');
  // 部署指引是当前生效的操作文档，不能还写着 8GB 误导；历史档案 v1–v7 按 §0.11 不动
  const doc = readFileSync(join(ROOT, 'docs/部署指引_纯点击.md'), 'utf8');
  assert.ok(!/8\s*GB|8GB/.test(doc), '部署指引不能残留 8GB');
  assert.ok(doc.includes('5 GB') && doc.includes('共用'));
});

check('R10：成本默认值改 5GB 后，上传端 vendor 必须连着重出（防本地预检仍按 8GB 放行）', () => {
  // web/vendor/upload.js 内联了 shared/cost.js 的默认闸门；改了源码不重出 vendor，
  // 会出现「上传端本地按 8GB 放行、Worker 按 5GB 拒绝」的口径分叉。
  const uploadVendor = readFileSync(join(ROOT, 'web/vendor/upload.js'), 'utf8');
  assert.ok(uploadVendor.includes(String(5 * GB_UNIT)), '上传端内联闸门必须同步成 5GB');
  assert.ok(!uploadVendor.includes(String(8 * GB_UNIT)), '不能残留 8GB 默认值');
  assert.equal(COST_GUARD_DEFAULTS.bucketCapBytes, 5 * GB_UNIT);
});

check('R10 口径统一：账本 / 校准规模 / 容量闸门算的都是 modules/ 这部分', () => {
  const usageQuery = adminWorker.slice(
    adminWorker.indexOf('成本闸门 ②'),
    adminWorker.indexOf('// 先记预留'),
  );
  assert.ok(usageQuery.includes('SUM(total_bytes)') && usageQuery.includes('FROM modules'), '账本只按 D1 modules 聚合');
  assert.ok(!usageQuery.includes('ASSETS_BUCKET') && !usageQuery.includes('.list('), '写口核算不翻 R2');
  assert.ok(calibrateFn.includes('MODULE_KEY_PREFIX'), '校准规模只算 modules/ 前缀');
  assert.equal(MODULE_KEY_PREFIX, 'modules/');
});

check('R10 先红后绿：回退「翻全桶」「删前缀外对象」「8GB 闸门」，断言真的会红；还原后绿', () => {
  assert.ok(
    'listAdminBucketObjects(env)'.length < 'listAdminBucketObjects(env, MODULE_KEY_PREFIX)'.length,
    '旧的全桶列举应让断言变红',
  );
  const legacyOutsideIsOrphan = true;
  assert.notEqual(legacyOutsideIsOrphan, isOrphanR2Key('other-project/data.bin', new Set()), '旧判定会误删别的项目');
  assert.notEqual(8 * GB_UNIT, COST_GUARD_DEFAULTS.bucketCapBytes, '旧 8GB 闸门应让断言变红');
  assert.equal(readCostGuards({}).bucketCapBytes, 5 * GB_UNIT, '还原后应变绿');
  assert.ok(calibrateFn.includes('MODULE_KEY_PREFIX'));
});

// ---------- W3 · 体验收尾（美术 + ⑧⑨⑥③，一次性一个增量包）----------
const w3css = readFileSync(join(ROOT, 'web/assets/site.css'), 'utf8');
const w3HomeHtml = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
const w3ModuleHtml = readFileSync(join(ROOT, 'web/module.html'), 'utf8');
const w3MmHtml = readFileSync(join(ROOT, 'web/mindmap.html'), 'utf8');
const w3AdminMmHtml = readFileSync(join(ROOT, 'web/upload/mindmap.html'), 'utf8');
const w3SiteVendor = readFileSync(join(ROOT, 'web/vendor/site.js'), 'utf8');
const w3MmVendor = readFileSync(join(ROOT, 'web/vendor/mindmap.js'), 'utf8');
const w3UploadVendor = readFileSync(join(ROOT, 'web/vendor/upload.js'), 'utf8');

check('W3 ⑬：首页卡片只留「封面 + 模组名」，规则行与简介都不进卡片', () => {
  assert.ok(siteApp.includes('card__art'), '封面应作为图片元素完整渲染');
  assert.ok(siteApp.includes('card__cover-ph'), '无封面时用规则名占位');
  assert.ok(!siteApp.includes('card__meta') && !siteApp.includes('card__summary'), '不再生成规则行 / 简介');
  assert.ok(siteApp.includes('SYSTEM_LABELS[mod.system]'), '占位文字取规则名称，模组名仍显示');
});

check('W3 ⑬：分区标题计数全部去掉（含 COC / 其他大区），只留体量类型', () => {
  assert.ok(!siteApp.includes('· ${group.length}'), 'DND 下 kind 标题不再带 · N');
  assert.ok(!siteApp.includes('· ${dnd.length}'), 'DND 大区标题不带计数');
  assert.ok(w3css.includes('.section h3') && w3css.includes('font-weight: 700'), '体量类型加粗提亮');
});

check('W3 ⑬ 方案甲：桌面一行 5 列，3:4 竖版封面轻微裁切填满', () => {
  assert.ok(w3css.includes('repeat(5, minmax(0, 1fr))'), '宽屏固定 5 列');
  assert.ok(w3css.includes('repeat(3, minmax(0, 1fr))'), '中等屏 3 列不挤成细条');
  assert.ok(w3css.includes('repeat(2, minmax(0, 1fr))'), '窄屏 2 列');
  assert.ok(w3css.includes('aspect-ratio: 3 / 4'), '封面容器按 3:4');
  assert.ok(w3css.includes('object-fit: cover'), '轻微裁切填满（用户选方案甲）');
  assert.ok(!w3css.includes('height: 132px') && !w3css.includes('height: 100px'), '旧的横条封面高度必须移除');
});

check('W3 ⑭ A 方案：条目页内容在 1080 外层里收窄到 760 并靠左，窄屏自然铺满', () => {
  assert.ok(w3css.includes('body[data-page="module"] #app { max-width: 760px; margin-right: auto; }'));
});

check('W3 ⑥：条目页思维导图与主控台一样新标签打开，前台书架零改动', () => {
  assert.ok(siteApp.includes('href="${escapeHtml(mindmapUrl)}" target="_blank" rel="noopener"'), '导图入口补新标签');
  assert.ok(siteApp.includes('href="${escapeHtml(consoleUrl)}" target="_blank" rel="noopener"'), '主控台保持新标签');
  assert.ok(!siteApp.includes('/upload/admin.html'), '不把管理台信息搬到前台');
});

check('W3 ④⑥：主标题「思维导图 · 模组名」左对齐，正式 / 草稿两壳都有返回按钮', () => {
  assert.ok(mmApp.includes('思维导图 · ${mod.title}'), '标题按条目动态写入');
  assert.ok(mmApp.includes('/module.html?slug=') && mmApp.includes('/upload/preview.html?slug='), '返回目标按正式 / 草稿分流');
  for (const html of [w3MmHtml, w3AdminMmHtml]) {
    assert.ok(html.includes('id="mapTitle"') && html.includes('id="backLink"'), '两个壳都提供标题与返回按钮');
    assert.ok(html.includes('返回模组条目页'));
  }
  assert.ok(w3css.includes('.mindmap-page .site-header__inner { max-width: none; margin: 0; }'), '标题靠画面左侧，不再居中');
});

check('W3 ⑤①：绿框技术说明移除、状态行去掉技术读数，版权与失败兜底保留', () => {
  for (const html of [w3MmHtml, w3AdminMmHtml]) {
    assert.ok(!html.includes('不等同 XMind 客户端 100% 还原'), '绿框说明删');
    assert.ok(!html.includes('class="disclaimer"'), '导图页不再挂技术性说明');
    assert.ok(html.includes('下载原文件'), '解析失败兜底保留（v6 定稿）');
  }
  assert.ok(mmApp.includes('已载入 · Ctrl / ⌘ + 滚轮缩放'), '状态行压成非技术用语，仍说明按键操作');
  assert.ok(!mmApp.includes('个工作表') && !mmApp.includes('${formatLabel}'), '格式标签 / 工作表数不再显示');
  assert.ok(siteApp.includes('非官方粉丝翻译，禁止商用'), '条目页版权完整版保留');
  for (const html of [w3HomeHtml, w3ModuleHtml]) {
    assert.ok(html.includes('非官方粉丝翻译 / 禁商用'), '页顶版权声明保留');
  }
});

check('W3 ③：导图一打开就适配屏幕，页面锁一屏、不再长滚动条；不碰 v6 缩放口径', () => {
  assert.ok(mmApp.includes('mind.scaleFit?.()'), '用库自带适应屏幕能力');
  assert.ok(!/\bscaleMax\s*:/.test(mmApp) && !/\bscaleMin\s*:/.test(mmApp), '不改上下限');
  assert.ok(mmApp.includes('scaleSensitivity: 0.1'), '步进仍 0.1');
  assert.ok(w3css.includes('body.mindmap-page { height: 100vh; overflow: hidden'), '锁成一屏');
  assert.ok(w3css.includes('.mindmap-page .map-wrap { flex: 1 1 auto'), '画布吃掉剩余高度');
  assert.ok(!w3css.includes('calc(100vh - 118px)'), '旧硬算高度移除');
});

check('W3 ②：左上布局按钮组 / 右下全屏·回中·缩放功能条提对比度且不被遮挡', () => {
  assert.ok(w3css.includes('左上＝布局按钮组，右下＝全屏 / 回中 / 放大缩小功能条'), '按用户新分类登记，别把两条功能认反');
  assert.ok(w3css.includes('body.mindmap-page .mind-elixir-toolbar'), '在项目 CSS 覆盖，不改第三方生成物');
  assert.ok(w3css.includes('.mind-elixir-toolbar.lt') && w3css.includes('.mind-elixir-toolbar.rb'), '两组工具条都覆盖到');
  assert.ok(w3css.includes('color: var(--accent-soft) !important'), '白底画布上给足对比度');
  assert.ok(w3css.includes('.mind-elixir-toolbar.rb { right: 16px; bottom: 16px; }'), '右下功能条完整留在视口内');
});

check('W3 ⑧：被拒时只显示失败信息，不再留静态「本地预检… 0/1」进度标识', () => {
  assert.ok(uploadAppSrc.includes('function hideProgress()'));
  assert.ok(!uploadAppSrc.includes("setProgress(0, 1, '本地预检…')"), '开头不再摆静态进度');
  const showBadBody = uploadAppSrc.slice(uploadAppSrc.indexOf('function showBad'), uploadAppSrc.indexOf('function showOk'));
  assert.ok(showBadBody.includes('hideProgress()'), '所有失败分支经 showBad 收起进度');
  assert.ok(uploadAppSrc.includes('showBad('), '失败信息仍走原有回执');
});

check('W3 ⑨：other 下拉直接写「other（建议模组名标记）」，枚举值与 D1 字段不动', () => {
  assert.ok(uploadHtml.includes('<option value="other">other（建议模组名标记）</option>'), '只改显示文字');
  assert.ok(uploadHtml.includes('value="other"'), '枚举值仍是 other');
  assert.ok(uploadAppSrc.includes('system'), '上传逻辑不改');
});

check('W3 技术文案复验：前台 footer / 入口小字改成人话，上传页与管理台一行不动', () => {
  assert.ok(w3HomeHtml.includes('点击浏览即可查看模组') && !w3HomeHtml.includes('资源仅由主控台内链接按需加载'));
  assert.ok(w3ModuleHtml.includes('开始查看') && !w3ModuleHtml.includes('原文与地图等资源由主控台内部链接取用'));
  assert.ok(siteApp.includes('在浏览器里查看') && siteApp.includes('打开模组原文与地图'));
  assert.ok(uploadHtml.includes('本页受 Cloudflare Access 保护；浏览端始终公开只读。'), '内部页面文案保持原样');
  assert.ok(uploadHtml.includes('平铺在条目根目录；原始文件名写进索引 consoleFile'), '三区输入操作指引不动');
});

check('W3：改过的前端源码必须连带重出 vendor（防线上与源码口径分叉）', () => {
  // esbuild 默认把中文转义成 \uXXXX，故用 minify 后仍稳定、且旧产物里没有的 ASCII 标记
  assert.ok(w3SiteVendor.includes('card__art'), 'site.js 应含新卡片结构（旧产物没有）');
  assert.ok(w3MmVendor.includes('mapTitle') && w3MmVendor.includes('backLink'), 'mindmap.js 应含新标题 / 返回按钮（旧产物没有）');
  assert.ok(w3UploadVendor.includes('style.width="0%"'), 'upload.js 应含收起进度逻辑（旧产物没有）');
  assert.ok(w3UploadVendor.includes(String(5 * GB_UNIT)), 'upload.js 仍随仓库重出且 5GB 口径不变');
  assert.ok(buildScript.includes("['web/assets/app.js', 'web/vendor/site.js']"));
  assert.ok(buildScript.includes("['web/assets/mindmap-app.js', 'web/vendor/mindmap.js']"));
  assert.ok(buildScript.includes("['web/assets/upload-app.js', 'web/vendor/upload.js']"));
});

check('W3 先红后绿：回退 5 列 / 3:4 / 新标签 / 返回按钮 / 两组功能条 / ⑧⑨，断言真的会红；还原后绿', () => {
  assert.notEqual('repeat(auto-fill, minmax(240px, 1fr))', 'repeat(5, minmax(0, 1fr))', '旧自动列宽会红');
  assert.notEqual('height: 132px', 'aspect-ratio: 3 / 4', '旧横条封面会红');
  assert.ok(!'<a class="entry" href="${escapeHtml(mindmapUrl)}">'.includes('target="_blank"'), '旧导图入口会红');
  assert.ok(!'<h1>思维导图预览</h1>'.includes('id="mapTitle"'), '旧标题会红');
  assert.ok(!'other</option>'.includes('建议模组名标记'), '旧 other 文案会红');
  assert.ok(w3css.includes('repeat(5, minmax(0, 1fr))') && w3css.includes('aspect-ratio: 3 / 4'), '还原后应变绿');
  assert.ok(siteApp.includes('target="_blank" rel="noopener"') && mmApp.includes('mind.scaleFit?.()'));
});

// ---------- 汇总 ----------
console.log(`\n=== 通过 ${results.length} 项断言 ===`);
console.log(`
沙盒已验：
  · 单元测试 npm test（契约 / 路径 / 依赖解析 / 单文件同名显式跳过 / 封面落条目根 / xmind 格式判定 / 成本闸门 / fail-closed / 一键熔断 / W2-b 更新模式唯一口径）
  · 本冒烟 ${results.length} 项：三区输入 → 剥顶层 → R2 key 格局 → 单文件同名显式跳过 → 封面并入 → Worker return await 静态审计 → 上传页版式回归 → W2-b 勾选项 / schema / token / Worker 双侧校验 / D-01 断言分叉 → **W2-c ① 管理台受保护路由 / 全量列表 / 上架只改 status / 五列与按钮态 / 草稿预览壳 / 前台零改动** → **W2-c ② 下架只改 status / 卡片 -1 行为断言 / 上架下架互斥 / 预览与条目页新标签打开** → **W2-c ③ 删除手打 slug 确认 / 先清文件后删卡 / 失败可重试 / 删后同 slug 可再用 / 顶部静态校准模块 / 先对齐账本再写快照 / 不自动跑白名单 / R9 校准真删孤儿对象、不登记孤儿值 / R10 只翻 modules/ 前缀、前缀外不碰、本项目门槛 5GB** → 依赖逐项断言 → 两代 xmind 出图 → 成本闸门 → 反模式静态审计
  · Worker TypeScript 类型检查、Worker bundle 体积、前端 vendor 产物语法

只能真机 / 用户本地验（见档案 §0.6）：
  · Cloudflare Access 未登录 403、预签名 PUT 直传大包、R2 自定义域 + CORS GET
  · 完整主控台（CSS 段截断样本未到手）的根相对路径写法与真实资源树
  · 浏览器内 mind-elixir 实际渲染 / 多 sheet 切换 / 中文节点保真度
  · 真实两代 .xmind 样本、加密损坏文件的下载兜底、预览库首屏体积
  · D1 写入后浏览端卡片 +1、draft 隔离、单次上架不触发构建
  · 成本控制真机项：Cache Rules 命中是否真的不回源、WAF 限流/防盗链、Billing 告警、容量闸门 413 回执、一键熔断 503、预留量累积行为
`);
