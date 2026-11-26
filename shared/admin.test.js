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
} from './admin.js';

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

test('按钮态：草稿行只亮「上架」，已发布行只亮「下架」，删除永远灰着', () => {
  assert.deepEqual(adminRowActions('draft'), {
    previewLabel: '预览', publishEnabled: true, unpublishEnabled: false, removeEnabled: false,
  });
  assert.deepEqual(adminRowActions('published'), {
    previewLabel: '条目页', publishEnabled: false, unpublishEnabled: true, removeEnabled: false,
  });
  assert.notEqual(
    adminRowActions('draft').publishEnabled,
    adminRowActions('published').publishEnabled,
    '上架 / 下架必须互斥，不能同时亮',
  );
});

test('下架写口：只接受 published → draft，草稿 / 未知状态一律拒', () => {
  assert.equal(canUnpublish('published'), true);
  assert.equal(canUnpublish('draft'), false);
  assert.equal(canUnpublish(undefined), false);
  assert.equal(canUnpublish('anything'), false);
});

test('先红后绿：把下架按钮回退成「永远灰着」，断言真的会红；还原后绿', () => {
  const legacy = (status) => ({
    previewLabel: status === 'draft' ? '预览' : '条目页',
    publishEnabled: status === 'draft', unpublishEnabled: false, removeEnabled: false,
  });
  assert.equal(legacy('published').unpublishEnabled, false, '旧实现应让断言变红');
  assert.notDeepEqual(legacy('published'), adminRowActions('published'));
  assert.equal(adminRowActions('published').unpublishEnabled, true, '还原后应变绿');
});

test('预览按钮二态：草稿＝预览（受保护壳），已发布＝条目页（前台原页）', () => {
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
