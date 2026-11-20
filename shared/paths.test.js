import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripTopFolder,
  buildR2Key,
  isUnsafeRelativePath,
  findDuplicateNames,
  buildUploadPlan,
  encodeKeyPath,
  skipSingleFileDuplicates,
  mergeCoverFile,
} from './paths.js';

test('stripTopFolder：目录树剥掉所选顶层文件夹名，完整保留子目录', () => {
  assert.equal(stripTopFolder('资源包/assets/a.png', '资源包'), 'assets/a.png');
  assert.equal(
    stripTopFolder('模组A/assets/maps/深层/地图 01.png', '模组A'),
    'assets/maps/深层/地图 01.png'
  );
});

test('stripTopFolder：顶层名不匹配时不剥；散拖文件保持自身文件名', () => {
  assert.equal(stripTopFolder('散文件.png', '资源包'), '散文件.png');
  assert.equal(stripTopFolder('assets/a.png', '资源包'), 'assets/a.png');
});

test('buildR2Key：slug 前缀 + 剥顶层后相对路径，顶层不挂成额外一层', () => {
  assert.equal(buildR2Key('frozen-malice', 'assets/a.png'), 'modules/frozen-malice/assets/a.png');
  assert.equal(buildR2Key('frozen-malice', '02_DM主控台.html'), 'modules/frozen-malice/02_DM主控台.html');
});

test('buildR2Key / encodeKeyPath：中文与特殊字符原样进 key，只在拼 URL 时编码', () => {
  const key = buildR2Key('frozen-malice', 'assets/中文 地图#1.png');
  assert.equal(key, 'modules/frozen-malice/assets/中文 地图#1.png');
  assert.equal(encodeKeyPath(key), 'modules/frozen-malice/assets/%E4%B8%AD%E6%96%87%20%E5%9C%B0%E5%9B%BE%231.png');
});

test('isUnsafeRelativePath：拒绝 .. / 根绝对 / 反斜杠 / 空段 / 空串', () => {
  for (const bad of ['../a.png', 'assets/../../a.png', '/assets/a.png', 'assets\\a.png', '', 'assets//a.png', 'assets/./a.png']) {
    assert.equal(isUnsafeRelativePath(bad), true, `应判不安全：${bad}`);
  }
  assert.equal(isUnsafeRelativePath('assets/深层/a b.png'), false);
});

test('findDuplicateNames：两单文件同名 → 拒', () => {
  const c = findDuplicateNames('同一个.html', '同一个.html', []);
  assert.ok(c.some((x) => x.includes('两单文件同名')));
});

test('findDuplicateNames：单文件与拖拽树同名 → 拒；树内自身重名 → 拒', () => {
  const c = findDuplicateNames('主控台.html', '导图.xmind', ['主控台.html', 'assets/a.png', 'assets/a.png']);
  assert.ok(c.some((x) => x.includes('单文件与拖拽树重名')));
  assert.ok(c.some((x) => x.includes('拖拽树内重名')));
});

test('findDuplicateNames：无重名返回空数组', () => {
  assert.deepEqual(findDuplicateNames('主控台.html', '导图.xmind', ['assets/a.png', 'assets/b.png']), []);
});

test('buildUploadPlan：两单文件平铺条目根，树按原结构挂在根下', () => {
  const plan = buildUploadPlan('frozen-malice', '主控台.html', '导图.xmind', ['assets/a.png', 'assets/maps/b.png']);
  assert.deepEqual(plan.map((p) => p.key), [
    'modules/frozen-malice/主控台.html',
    'modules/frozen-malice/导图.xmind',
    'modules/frozen-malice/assets/a.png',
    'modules/frozen-malice/assets/maps/b.png',
  ]);
});

// ---------- W1 #5 后续 / 包①b：单文件同名显式跳过 ----------

test('skipSingleFileDuplicates：只剔除与两单文件完全同名的资源树项，返回 kept / skipped', () => {
  const rels = [
    '02_DM主控台.html',
    '01_全局备团思维导图.xmind',
    'maps/map1_dm.jpg',
    '模组原文/魔兽世界 - 死亡矿井.html',
  ];
  const { kept, skipped } = skipSingleFileDuplicates(
    '02_DM主控台.html', '01_全局备团思维导图.xmind', rels,
  );
  assert.deepEqual(skipped.sort(), ['01_全局备团思维导图.xmind', '02_DM主控台.html'].sort());
  assert.deepEqual(kept, ['maps/map1_dm.jpg', '模组原文/魔兽世界 - 死亡矿井.html']);
});

test('skipSingleFileDuplicates：只按完整 relativePath 匹配，带子目录的同名文件不被误剔', () => {
  const { kept, skipped } = skipSingleFileDuplicates(
    '02_DM主控台.html', '导图.xmind',
    ['assets/02_DM主控台.html', '02_DM主控台.html', 'assets/导图.xmind'],
  );
  assert.deepEqual(skipped, ['02_DM主控台.html']);
  assert.deepEqual(kept, ['assets/02_DM主控台.html', 'assets/导图.xmind']);
});

test('防误伤：跳过之后 findDuplicateNames 仍拒绝树内自身重名（同一文件夹拖两次）', () => {
  const { kept } = skipSingleFileDuplicates(
    '02_DM主控台.html', '导图.xmind',
    ['02_DM主控台.html', 'maps/a.png', 'maps/a.png'],
  );
  assert.deepEqual(kept, ['maps/a.png', 'maps/a.png']);
  assert.ok(
    findDuplicateNames('02_DM主控台.html', '导图.xmind', kept)
      .some((x) => x.includes('拖拽树内重名')),
  );
});

test('防误伤：跳过之后 buildUploadPlan 无重复 relativePath，两单文件仍平铺条目根', () => {
  const { kept } = skipSingleFileDuplicates(
    '02_DM主控台.html', '导图.xmind',
    ['02_DM主控台.html', '导图.xmind', 'maps/a.png', '模组原文/原文.html'],
  );
  const plan = buildUploadPlan('wow-deadmines', '02_DM主控台.html', '导图.xmind', kept);
  assert.deepEqual(plan.map((p) => p.relativePath), [
    '02_DM主控台.html', '导图.xmind', 'maps/a.png', '模组原文/原文.html',
  ]);
  assert.equal(new Set(plan.map((p) => p.relativePath)).size, plan.length);
});

// ---------- 包②：封面作为「新增的可选资源内容」落条目根 ----------

test('mergeCoverFile：本地封面落条目根（裸文件名），不建 cover/ 子层级', () => {
  const { paths, conflicts } = mergeCoverFile(
    '02_DM主控台.html', '导图.xmind',
    ['maps/a.png', '模组原文/原文.html'],
    '死亡矿井封面.jpg',
  );
  assert.deepEqual(conflicts, []);
  assert.deepEqual(paths, ['maps/a.png', '模组原文/原文.html', '死亡矿井封面.jpg']);
  const plan = buildUploadPlan('wow-deadmines', '02_DM主控台.html', '导图.xmind', paths);
  assert.equal(
    plan.at(-1).key,
    'modules/wow-deadmines/死亡矿井封面.jpg',
  );
  assert.ok(!plan.some((p) => p.key.includes('/cover/')));
});

test('mergeCoverFile：没选本地封面时原样返回，外链文本框路径不受影响', () => {
  const { paths, conflicts } = mergeCoverFile(
    '02_DM主控台.html', '导图.xmind', ['maps/a.png'], '',
  );
  assert.deepEqual(paths, ['maps/a.png']);
  assert.deepEqual(conflicts, []);
});

test('mergeCoverFile：封面与两单文件或资源树内文件同名 → 显式拒绝，不静默改名/覆盖', () => {
  const a = mergeCoverFile('02_DM主控台.html', '导图.xmind', ['maps/a.png'], '02_DM主控台.html');
  assert.ok(a.conflicts.some((x) => x.includes('封面与单文件同名')));
  assert.deepEqual(a.paths, ['maps/a.png']);
  const b = mergeCoverFile('02_DM主控台.html', '导图.xmind', ['maps/a.png'], 'maps/a.png');
  assert.ok(b.conflicts.some((x) => x.includes('封面与资源树内文件同名')));
  assert.deepEqual(b.paths, ['maps/a.png']);
});

test('防误伤：封面是包内多余未引用文件，主控台真实引用仍能被命中', () => {
  const { paths } = mergeCoverFile(
    '02_DM主控台.html', '导图.xmind',
    ['模组原文/魔兽世界 - 死亡矿井.html'], '封面.jpg',
  );
  assert.deepEqual(paths, ['模组原文/魔兽世界 - 死亡矿井.html', '封面.jpg']);
  assert.equal(new Set(paths).size, paths.length);
});
