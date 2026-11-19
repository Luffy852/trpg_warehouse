import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEMS, KINDS, STATUSES, slugify, validateMeta } from './contract.js';

const validMeta = {
  title: '封冻恶疾',
  slug: 'frozen-malice',
  system: 'dnd',
  kind: 'module',
  status: 'published',
  summary: '',
  cover: '',
};

test('slugify：英文标题生成小写短横线 slug', () => {
  assert.equal(slugify('Death Mines: The Lost Vault!'), 'death-mines-the-lost-vault');
  assert.equal(slugify('  Frozen--Malice  '), 'frozen-malice');
});

test('slugify：纯中文标题被过滤为空，要求人工填 slug', () => {
  assert.equal(slugify('封冻恶疾'), '');
});

test('枚举固定为三套，不擅自扩展', () => {
  assert.deepEqual(SYSTEMS, ['dnd', 'coc', 'other']);
  assert.deepEqual(KINDS, ['campaign', 'module', 'encounter']);
  assert.deepEqual(STATUSES, ['draft', 'published']);
});

test('validateMeta：合法元数据零错误', () => {
  assert.deepEqual(validateMeta(validMeta), []);
});

test('validateMeta：非法 system / kind / status 均被拒', () => {
  const errors = validateMeta({ ...validMeta, system: 'dnd5e', kind: 'series', status: 'live' });
  assert.equal(errors.length, 3);
});

test('validateMeta：非法 slug 被拒（含空格 / 大写 / 中文）', () => {
  assert.ok(validateMeta({ ...validMeta, slug: 'Bad Slug' }).length > 0);
  assert.ok(validateMeta({ ...validMeta, slug: '中文slug' }).length > 0);
  assert.ok(validateMeta({ ...validMeta, slug: '' }).length > 0);
});

test('validateMeta：title 必填', () => {
  assert.ok(validateMeta({ ...validMeta, title: '   ' }).some((e) => e.includes('title')));
});
