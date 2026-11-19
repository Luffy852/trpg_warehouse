import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectXmind } from './xmind.js';

const enc = new TextEncoder();
const b = (s) => enc.encode(s);

const MODERN_JSON = JSON.stringify([
  {
    id: 'sheet-1',
    title: '主画布',
    rootTopic: {
      id: 'root',
      title: '根节点',
      children: { attached: [{ id: 'n1', title: '子节点' }] },
    },
  },
]);

const UPGRADE_PLACEHOLDER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<xmap-content version="2.0"><sheet id="s"><topic id="t"><title>Please update XMind to open this file</title></topic></sheet></xmap-content>`;

const XMIND8_XML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" version="2.0">
  <sheet id="s1" theme="default"><topic id="root" structure-class="org.xmind.ui.map.unbalanced">
    <title>冰封恶疾</title><children><topics type="attached"><topic id="n1"><title>第一幕</title></topic></topics></children>
  </topic><title>Sheet 1</title></sheet>
</xmap-content>`;

test('inspectXmind：有 content.json 一律优先，即使同时带占位 content.xml 也不空图', () => {
  const r = inspectXmind({ 'content.json': b(MODERN_JSON), 'content.xml': b(UPGRADE_PLACEHOLDER_XML) });
  assert.equal(r.ok, true);
  assert.equal(r.format, 'json');
});

test('inspectXmind：仅 XMind 8 的 content.xml → 判为旧格式可读', () => {
  const r = inspectXmind({ 'content.xml': b(XMIND8_XML) });
  assert.equal(r.ok, true);
  assert.equal(r.format, 'xml');
});

test('inspectXmind：只有「请升级」占位 XML → 拒，理由含占位', () => {
  const r = inspectXmind({ 'content.xml': b(UPGRADE_PLACEHOLDER_XML) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /占位/);
});

test('inspectXmind：两个内容文件都没有 → 拒，提示可能不是 xmind', () => {
  const r = inspectXmind({ 'metadata.json': b('{}') });
  assert.equal(r.ok, false);
  assert.match(r.reason, /content\.json/);
});

test('inspectXmind：XML 里完全没有 topic 节点 → 拒，不留空图', () => {
  const r = inspectXmind({ 'content.xml': b('<xmap-content><sheet id="s"></sheet></xmap-content>') });
  assert.equal(r.ok, false);
});
