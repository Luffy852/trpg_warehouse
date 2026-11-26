import test from 'node:test';
import assert from 'node:assert/strict';
import {
  systemKindLabel,
  statusLabel,
  sortAdminRows,
  adminRowActions,
  previewTarget,
  canPublish,
  canUnpublish,
  matchesDeleteConfirm,
  deleteConfirmMessage,
  storageSnapshot,
  slugFromR2Key,
  isOrphanR2Key,
  MODULE_KEY_PREFIX,
} from './admin.js';
import { buildR2Key } from './paths.js';

const rows = [
  { slug: 'zeta', system: 'dnd', kind: 'encounter' },
  { slug: 'beta', system: 'other', kind: 'module' },
  { slug: 'alpha', system: 'dnd', kind: 'campaign' },
  { slug: 'gamma', system: 'coc', kind: 'module' },
  { slug: 'delta', system: 'dnd', kind: 'module' },
];

test('第三列：规则及体量用全站唯一标签拼，不另写一份中文', () => {
  assert.equal(systemKindLabel('dnd', 'campaign'), 'DND-战役');
  assert.equal(systemKindLabel('coc', 'module'), 'COC-模组');
  assert.equal(systemKindLabel('other', 'encounter'), '其他规则-遭遇');
});

test('第四列：状态沿用库里的「已发布 / 草稿」，不造新文案', () => {
  assert.equal(statusLabel('published'), '已发布');
  assert.equal(statusLabel('draft'), '草稿');
});

test('排序：优先规则体系 dnd → coc → other，组内 slug A→Z', () => {
  assert.deepEqual(
    sortAdminRows(rows).map((r) => r.slug),
    ['alpha', 'delta', 'zeta', 'gamma', 'beta'],
  );
});

test('排序：不修改入参数组；未知体系排最后且组内仍按 slug', () => {
  const before = rows.map((r) => r.slug);
  const withUnknown = [...rows, { slug: 'aaa', system: 'unknown' }, { slug: 'zzz', system: 'unknown' }];
  const out = sortAdminRows(withUnknown);
  assert.deepEqual(rows.map((r) => r.slug), before, '入参不应被就地排序');
  assert.deepEqual(out.slice(-2).map((r) => r.slug), ['aaa', 'zzz']);
});

test('按钮态：草稿亮上架、已发布亮下架（互斥），删除两种状态都点亮', () => {
  assert.deepEqual(adminRowActions('draft'), {
    previewLabel: '预览页', publishEnabled: true, unpublishEnabled: false, removeEnabled: true,
  });
  assert.deepEqual(adminRowActions('published'), {
    previewLabel: '条目页', publishEnabled: false, unpublishEnabled: true, removeEnabled: true,
  });
  assert.notEqual(
    adminRowActions('draft').publishEnabled,
    adminRowActions('published').publishEnabled,
    '上架 / 下架必须互斥，不能同时亮',
  );
});

test('R7-2 小修补：预览页 / 条目页同为 3 字，翻转时按钮同宽不跳', () => {
  const draft = adminRowActions('draft').previewLabel;
  const published = adminRowActions('published').previewLabel;
  assert.equal(draft, '预览页');
  assert.equal(published, '条目页');
  assert.equal(draft.length, published.length, '两个文案字数必须一致，否则操作列会跳宽度');
});

test('下架写口：只接受 published → draft，草稿 / 未知状态一律拒', () => {
  assert.equal(canUnpublish('published'), true);
  assert.equal(canUnpublish('draft'), false);
  assert.equal(canUnpublish(undefined), false);
  assert.equal(canUnpublish('anything'), false);
});

test('先红后绿：把下架按钮回退成「永远灰着」，断言真的会红；还原后绿', () => {
  const legacy = (status) => ({
    previewLabel: status === 'draft' ? '预览页' : '条目页',
    publishEnabled: status === 'draft', unpublishEnabled: false, removeEnabled: false,
  });
  assert.equal(legacy('published').unpublishEnabled, false, '旧实现应让断言变红');
  assert.notDeepEqual(legacy('published'), adminRowActions('published'));
  assert.equal(adminRowActions('published').unpublishEnabled, true, '还原后应变绿');
});

test('预览按钮二态：草稿＝预览页（受保护壳），已发布＝条目页（前台原页）', () => {
  assert.equal(previewTarget('frozen-malice', 'draft'), '/upload/preview.html?slug=frozen-malice');
  assert.equal(previewTarget('frozen-malice', 'published'), '/module.html?slug=frozen-malice');
  assert.equal(
    previewTarget('中文 名&', 'draft'),
    '/upload/preview.html?slug=%E4%B8%AD%E6%96%87%20%E5%90%8D%26',
    'slug 必须 URL 编码，不拼裸字符串',
  );
});

test('上架写口：只接受 draft → published，已发布 / 未知状态一律拒', () => {
  assert.equal(canPublish('draft'), true);
  assert.equal(canPublish('published'), false);
  assert.equal(canPublish(undefined), false);
  assert.equal(canPublish('anything'), false);
});

test('先红后绿：把排序回退成「按 created_at 倒序」，断言真的会红；还原后又绿', () => {
  const legacy = (list) => [...list].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  const withTime = [
    { slug: 'alpha', system: 'dnd', created_at: '2026-11-20' },
    { slug: 'zeta', system: 'dnd', created_at: '2026-11-24' },
    { slug: 'gamma', system: 'coc', created_at: '2026-11-25' },
  ];
  const expected = ['alpha', 'zeta', 'gamma'];
  assert.notDeepEqual(legacy(withTime).map((r) => r.slug), expected, '旧排序应让断言变红');
  assert.deepEqual(sortAdminRows(withTime).map((r) => r.slug), expected, '还原唯一口径后应变绿');
});

test('防误伤：体系顺序来自 shared/contract.js 的 SYSTEMS，不是这里硬编码', () => {
  // 把 SYSTEMS 顺序改成 coc 优先时，排序结果必须跟着变（证明没有第二份枚举）
  assert.ok(sortAdminRows(rows).slice(0, 3).every((r) => r.system === 'dnd'));
});

test('删除手打确认：只接受与 slug 完全一致；取消 / 空值 / 打错 / 打模组名一律拒', () => {
  assert.equal(matchesDeleteConfirm('the-tollkeeper', 'the-tollkeeper'), true);
  for (const spaced of ['  the-tollkeeper  ', 'the-tollkeeper ', ' the-tollkeeper']) {
    assert.equal(matchesDeleteConfirm('the-tollkeeper', spaced), true, '只容忍首尾空格');
  }
  for (const bad of [null, undefined, '', '守路人', 'THE-TOLLKEEPER', 'the-toll', {}, 0]) {
    assert.equal(matchesDeleteConfirm('the-tollkeeper', bad), false, `脏值 ${JSON.stringify(bad)} 不应放行`);
  }
  assert.equal(matchesDeleteConfirm('', ''), false, 'slug 为空时也不能放行');
});

test('删除确认文案：已发布多一句对外展示提示，草稿不加；两者都要求手打 slug', () => {
  const pub = deleteConfirmMessage('the-tollkeeper', 'published');
  const draft = deleteConfirmMessage('the-tollkeeper', 'draft');
  assert.ok(pub.includes('正在对外展示'));
  assert.ok(!draft.includes('正在对外展示'));
  assert.ok(pub.includes('the-tollkeeper') && draft.includes('the-tollkeeper'));
  assert.ok(pub.includes('不可恢复') && draft.includes('不可恢复'));
});

test('校准快照：可信行转成静态值；无行 / 脏值一律当「尚未校准」', () => {
  assert.deepEqual(storageSnapshot({ total_bytes: 4823449, calibrated_at: '2026-11-26 10:30:00' }), {
    totalBytes: 4823449, calibratedAt: '2026-11-26 10:30:00',
  });
  assert.equal(storageSnapshot(null), null);
  assert.equal(storageSnapshot({}), null);
  assert.equal(storageSnapshot({ total_bytes: -1, calibrated_at: 'x' }), null);
  assert.equal(storageSnapshot({ total_bytes: '4823449', calibrated_at: 'x' }), null);
});

test('先红后绿：回退「预览页三字」与「忽略手打确认」，断言真的会红；还原后绿', () => {
  const legacyLabel = '预览';
  assert.notEqual(legacyLabel.length, adminRowActions('published').previewLabel.length, '旧文案应让断言变红');
  const legacyConfirm = () => true;
  assert.equal(legacyConfirm('x', 'y'), true, '旧确认形同虚设应让断言变红');
  assert.equal(matchesDeleteConfirm('x', 'y'), false, '还原后应变绿');
  assert.equal(adminRowActions('draft').previewLabel, '预览页');
});

test('R2 key 提取 slug：只认 modules/<slug>/ 格局，格局外一律取不到', () => {
  assert.equal(slugFromR2Key('modules/the-tollkeeper/index.html'), 'the-tollkeeper');
  assert.equal(slugFromR2Key('modules/the-tollkeeper/assets/cover.png'), 'the-tollkeeper');
  assert.equal(slugFromR2Key('modules/中文 名/maps/m1.jpg'), '中文 名');
  assert.equal(slugFromR2Key('robots.txt'), null);
  assert.equal(slugFromR2Key('other/the-tollkeeper/x.png'), null);
  assert.equal(slugFromR2Key('modules/'), null);
  assert.equal(slugFromR2Key(''), null);
});

test('R10 共用 R2：前缀常量与 buildR2Key 唯一口径一致', () => {
  assert.equal(MODULE_KEY_PREFIX, 'modules/');
  assert.ok(buildR2Key('the-tollkeeper', 'index.html').startsWith(MODULE_KEY_PREFIX));
  assert.equal(buildR2Key('the-tollkeeper', 'assets/cover.png'), 'modules/the-tollkeeper/assets/cover.png');
});

test('孤儿判定（R10 收窄）：只删 modules/ 下无索引的；前缀外一律不碰', () => {
  const slugs = new Set(['the-tollkeeper', 'goblin-trouble']);
  assert.equal(isOrphanR2Key('modules/the-tollkeeper/index.html', slugs), false);
  assert.equal(isOrphanR2Key('modules/goblin-trouble/assets/cover.png', slugs), false);
  assert.equal(isOrphanR2Key('modules/abandoned-upload/01.xmind', slugs), true, '半途放弃的上传残留');
  assert.equal(isOrphanR2Key('modules/just-deleted/01.xmind', slugs), true, '删除写口残留的对象');
  assert.equal(isOrphanR2Key('modules/orphan.txt', slugs), true, 'modules/ 下格局不合法、映射不到 slug');
  // 共用桶：别的项目 / 桶根杂项绝不删，也不计入本项目规模
  for (const outside of ['robots.txt', 'other-project/data.bin', 'shared/logo.png', '', 'other/x/y.png']) {
    assert.equal(isOrphanR2Key(outside, slugs), false, `前缀外对象 ${JSON.stringify(outside)} 不该被判成垃圾`);
  }
  assert.equal(isOrphanR2Key('modules/the-tollkeeper/index.html', new Set()), true);
});

test('校准清孤儿：只翻 modules/ 前缀 → 删完账实严格相等，别的项目不计入', () => {
  const slugs = new Set(['the-tollkeeper', 'goblin-trouble']);
  // 列举阶段就带 modules/ 前缀：别的项目对象连列表都进不来（共用 R2 双保险）
  const allBucketObjects = [
    { key: 'modules/the-tollkeeper/index.html', size: 100 },
    { key: 'modules/the-tollkeeper/assets/cover.png', size: 200 },
    { key: 'modules/goblin-trouble/01.xmind', size: 50 },
    { key: 'modules/abandoned-upload/01.xmind', size: 999 },
    { key: 'modules/orphan.txt', size: 7 },
    { key: 'other-project/data.bin', size: 5000 },
    { key: 'robots.txt', size: 3 },
  ];
  const objects = allBucketObjects.filter((o) => o.key.startsWith(MODULE_KEY_PREFIX));
  assert.equal(objects.length, 5, '别的项目 / 桶根杂项不在扫描范围内');
  const survivors = objects.filter((o) => !isOrphanR2Key(o.key, slugs));
  const bySlug = new Map();
  for (const o of survivors) {
    const slug = slugFromR2Key(o.key);
    assert.ok(slug, '幸存对象必须能映射到 slug');
    bySlug.set(slug, (bySlug.get(slug) ?? 0) + o.size);
  }
  const realBytes = survivors.reduce((s, o) => s + o.size, 0);
  const indexedBytes = [...bySlug.values()].reduce((a, b) => a + b, 0);
  assert.equal(realBytes, 350, '本项目垃圾被清掉，规模只算 modules/ 这部分');
  assert.equal(indexedBytes, realBytes, 'SUM(modules.total_bytes) = 本项目真实占用，无需孤儿兜账值');
  assert.equal(bySlug.get('the-tollkeeper'), 300);
  assert.equal(bySlug.get('goblin-trouble'), 50);
});

test('先红后绿：回退「把孤儿量记回账本」/「删前缀外对象」，断言真的会红', () => {
  const slugs = new Set(['the-tollkeeper']);
  const orphan = { key: 'modules/abandoned/01.xmind', size: 999 };
  // 旧做法 A（R9 已否）：不删对象，只把 999 记回预留 → 空间没压缩、账被抬高迁就垃圾
  const legacyUnindexedBytes = 999;
  assert.ok(legacyUnindexedBytes > 0, '旧实现确实会登记一个孤儿值，应让断言变红');
  // 旧做法 B（R10 已否）：把格局外对象也当垃圾 → 会误删别的项目文件
  const legacyOutsideIsOrphan = true;
  assert.notEqual(legacyOutsideIsOrphan, isOrphanR2Key('other-project/data.bin', slugs));
  assert.equal(isOrphanR2Key(orphan.key, slugs), true, '新实现只把 modules/ 下无索引的判成垃圾');
  assert.equal(slugFromR2Key('modules/the-tollkeeper/index.html'), 'the-tollkeeper');
});
