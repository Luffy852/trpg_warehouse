import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReferences, buildAvailableSet, findMissingDeps } from './deps.js';

test('extractReferences：href / src / iframe src 全部抓到并归一化', () => {
  const html = `
    <a href="原文.html">原文</a>
    <a href="./source/第二章.html">多文件原文</a>
    <img src="assets/maps/地图 01.png">
    <iframe src="frames/npc.html?ver=2#top"></iframe>
    <script src="assets/app.js"></script>
  `;
  const refs = extractReferences(html);
  assert.deepEqual(refs.local, ['原文.html', 'source/第二章.html', 'assets/maps/地图 01.png', 'frames/npc.html', 'assets/app.js']);
  assert.deepEqual(refs.external, []);
  assert.deepEqual(refs.rootRelative, []);
});

test('extractReferences：绝对外链与 protocol-relative 不纳入存在性断言', () => {
  const html = `
    <img src="https://media.dndbeyond.com/a.png">
    <img src="//cdn.example.com/b.png">
    <a href="http://example.com/c">外链</a>
  `;
  const refs = extractReferences(html);
  assert.equal(refs.local.length, 0);
  assert.equal(refs.external.length, 3);
});

test('extractReferences：根相对 /... 单独登记为未验风险，不混入本地依赖', () => {
  const refs = extractReferences('<img src="/static/logo.png">');
  assert.deepEqual(refs.rootRelative, ['/static/logo.png']);
  assert.deepEqual(refs.local, []);
});

test('extractReferences：# 锚点 / data: / javascript: / 空 href / mailto: 全部忽略', () => {
  const html = `
    <a href="#chapter1">锚点</a>
    <img src="data:image/png;base64,AAAA">
    <a href="javascript:void(0)">js</a>
    <a href="">空</a>
    <a href="mailto:a@b.com">mail</a>
  `;
  const refs = extractReferences(html);
  assert.deepEqual(refs.local, []);
  assert.equal(refs.external.length, 0);
});

test('extractReferences：./ 与 ../ 归一化、URI 解码、query/hash 去除、重复去重', () => {
  const html = `
    <a href="./assets/../assets/a%20b.png?v=1#x"></a>
    <a href="assets/a b.png"></a>
    <a href="assets/深层/../深层/c.png"></a>
  `;
  const refs = extractReferences(html);
  assert.deepEqual(refs.local, ['assets/a b.png', 'assets/深层/c.png']);
});

test('extractReferences：越出条目根的 ../ 判为可疑，不生成可断言依赖', () => {
  const refs = extractReferences('<a href="../outside.png"></a>');
  assert.deepEqual(refs.local, []);
  assert.ok(refs.ignored.includes('../outside.png'));
});

test('findMissingDeps：缺任一被主控台实际引用的本地文件即报缺', () => {
  const refs = extractReferences('<a href="原文.html"></a><img src="assets/maps/m.png">');
  const available = buildAvailableSet('主控台.html', '导图.xmind', ['原文.html']);
  assert.deepEqual(findMissingDeps(refs, available), ['assets/maps/m.png']);
});

test('findMissingDeps：树内多余的未被引用文件不拦', () => {
  const refs = extractReferences('<a href="原文.html"></a>');
  const available = buildAvailableSet('主控台.html', '导图.xmind', ['原文.html', '未被引用的废图.png']);
  assert.deepEqual(findMissingDeps(refs, available), []);
});

test('不预设必备文件名清单：单文件原文与多文件原文两种形态都能过', () => {
  const single = extractReferences('<a href="single.html"></a>');
  assert.deepEqual(findMissingDeps(single, buildAvailableSet('主控台.html', '导图.xmind', ['single.html'])), []);
  const multi = extractReferences('<a href="part1.html"></a><a href="part2.html"></a>');
  assert.deepEqual(findMissingDeps(multi, buildAvailableSet('主控台.html', '导图.xmind', ['part1.html', 'part2.html'])), []);
});

// ---------- W1 #5 回归：完整主控台 <script> 模板字面量不得被当成文件名 ----------

test('extractReferences：<script> 模板字面量里的 ${...} 不进 local，真实静态引用仍抓到', () => {
  const html = '<script>\n'
    + '  const card = `<img class="thumb" src="${m[mapVer]}" alt="${m.name}">`;\n'
    + '</script>\n'
    + '<a href="模组原文/魔兽世界 - 死亡矿井.html">原文</a>';
  const refs = extractReferences(html);
  assert.deepEqual(refs.local, ['模组原文/魔兽世界 - 死亡矿井.html']);
  assert.ok(!refs.local.includes('${m[mapVer]}'));
});

test('extractReferences：<script> 里 JS 属性赋值 .src=m[ver]; 不进 local', () => {
  const html = '<script>\n'
    + '  document.getElementById("mapImg").src=m[ver];\n'
    + '</script>\n'
    + '<img src="assets/maps/真实地图.png">';
  const refs = extractReferences(html);
  assert.deepEqual(refs.local, ['assets/maps/真实地图.png']);
  assert.ok(!refs.local.includes('m[ver];'));
});

test('extractReferences：HTML 注释里被注释掉的引用不进 local', () => {
  const html = '<!-- <img src="assets/旧版地图.png"> -->\n'
    + '<img src="assets/现用地图.png">';
  const refs = extractReferences(html);
  assert.deepEqual(refs.local, ['assets/现用地图.png']);
});

test('extractReferences：值里含 ${ 的异常引用归 ignored，不当缺失文件', () => {
  const refs = extractReferences('<img src="${dynamic}">');
  assert.deepEqual(refs.local, []);
  assert.ok(refs.ignored.includes('${dynamic}'));
});

test('防误伤：<script src="assets/app.js"> 开标签上的真实引用仍抓到', () => {
  const html = '<script src="assets/app.js"></script><a href="原文.html"></a>';
  const refs = extractReferences(html);
  assert.deepEqual(refs.local.sort(), ['assets/app.js', '原文.html'].sort());
});

test('防误伤：<template> 内的静态引用是真实 HTML，仍纳入存在性断言', () => {
  const html = '<template><img src="assets/弹窗图.png"></template><a href="原文.html"></a>';
  const refs = extractReferences(html);
  assert.deepEqual(refs.local.sort(), ['assets/弹窗图.png', '原文.html'].sort());
});
