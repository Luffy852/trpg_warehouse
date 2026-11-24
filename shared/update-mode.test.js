import test from 'node:test';
import assert from 'node:assert/strict';
import { decideUploadMode, expectedCardDelta, verifyUpdatedContent } from './update-mode.js';

const submitted = {
  title: '封冻恶疾（修订版）',
  slug: 'frozen-malice',
  system: 'dnd',
  kind: 'campaign',
  status: 'published',
  summary: '改过的简介',
  cover: 'assets/cover.png',
  consoleFile: '02_DM主控台.html',
  mindmapFile: '剧情导图.xmind',
};

test('默认拒绝静默覆盖：slug 已存在且未勾选 → 拒绝，不带 mode', () => {
  assert.deepEqual(decideUploadMode({ exists: true, isUpdate: false }), {
    allowed: false, mode: null, code: 'SLUG_EXISTS',
  });
});

test('勾选更新且 slug 已存在 → 允许覆盖，mode=updated', () => {
  assert.deepEqual(decideUploadMode({ exists: true, isUpdate: true }), {
    allowed: true, mode: 'updated', code: null,
  });
});

test('勾选更新但 slug 不存在 → 正常新建，mode=created', () => {
  assert.deepEqual(decideUploadMode({ exists: false, isUpdate: true }), {
    allowed: true, mode: 'created', code: null,
  });
});

test('未勾选且 slug 不存在 → 正常新建，mode=created', () => {
  assert.deepEqual(decideUploadMode({ exists: false, isUpdate: false }), {
    allowed: true, mode: 'created', code: null,
  });
});

test('fail-safe：isUpdate 缺失 / 字符串 / 非布尔脏值一律按未勾选处理', () => {
  for (const dirty of [undefined, null, 'true', 1, 0, {}, []]) {
    assert.equal(
      decideUploadMode({ exists: true, isUpdate: dirty }).allowed,
      false,
      `脏值 ${JSON.stringify(dirty)} 不应打开覆盖口子`,
    );
  }
  assert.equal(decideUploadMode({ exists: false, isUpdate: undefined }).mode, 'created');
});

test('卡片数期望：新建 published +1、新建 draft 0', () => {
  assert.equal(expectedCardDelta({ mode: 'created', previousStatus: null, nextStatus: 'published' }), 1);
  assert.equal(expectedCardDelta({ mode: 'created', previousStatus: null, nextStatus: 'draft' }), 0);
});

test('卡片数期望：更新且状态不变 = 0（D-01 主场景「卡片数不变、内容已更新」）', () => {
  assert.equal(expectedCardDelta({ mode: 'updated', previousStatus: 'published', nextStatus: 'published' }), 0);
  assert.equal(expectedCardDelta({ mode: 'updated', previousStatus: 'draft', nextStatus: 'draft' }), 0);
});

test('卡片数期望：更新时 draft ↔ published 状态变化按旧状态算 ±1，不让断言说谎', () => {
  assert.equal(expectedCardDelta({ mode: 'updated', previousStatus: 'draft', nextStatus: 'published' }), 1);
  assert.equal(expectedCardDelta({ mode: 'updated', previousStatus: 'published', nextStatus: 'draft' }), -1);
});

test('内容已更新：列表里该条目与本次提交逐字段一致 → ok', () => {
  const row = {
    ...submitted,
    baseUrl: 'https://asset.example/modules/frozen-malice/',
    createdAt: '2026-11-24 00:00:00',
  };
  assert.deepEqual(verifyUpdatedContent({ row, submitted }), { ok: true, visible: true, mismatches: [] });
});

test('先红后绿：任一内容字段未更新 → 断言真的会红；改回后又绿', () => {
  const stale = { ...submitted, title: '旧标题', kind: 'module', mindmapFile: '旧导图.xmind' };
  const red = verifyUpdatedContent({ row: stale, submitted });
  assert.equal(red.ok, false);
  assert.equal(red.mismatches.length, 3);
  assert.ok(red.mismatches.some((m) => m.startsWith('title:')));
  assert.ok(red.mismatches.some((m) => m.startsWith('kind:')));
  assert.ok(red.mismatches.some((m) => m.startsWith('mindmapFile:')));
  assert.equal(verifyUpdatedContent({ row: { ...submitted }, submitted }).ok, true);
});

test('draft→draft 更新在浏览端列表不可见：交给 Worker D1 写后读回校验兜住', () => {
  assert.deepEqual(verifyUpdatedContent({ row: null, submitted }), {
    ok: true, visible: false, mismatches: [],
  });
});

test('防误伤：slug 是抓手、派生字段不参与内容比对', () => {
  const row = {
    ...submitted,
    slug: '另一个-slug',
    baseUrl: 'https://asset.example/modules/frozen-malice/',
    createdAt: '2026-11-24 00:00:00',
    objectCount: 7,
  };
  // slug 由 URL / 索引定位，调用方已按 prep.slug 找 row；这里只验内容字段不被派生值干扰
  assert.equal(verifyUpdatedContent({ row, submitted }).ok, true);
});
