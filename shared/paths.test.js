import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripTopFolder,
  buildR2Key,
  isUnsafeRelativePath,
  findDuplicateNames,
  buildUploadPlan,
  encodeKeyPath,
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
