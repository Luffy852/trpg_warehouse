// 浏览端唯一渲染逻辑：源码在这里，产物是 web/vendor/site.js（esbuild 打包）。
// 纯点击-查看：无搜索框、无文本输入交互；首屏只拉一次 /api/modules。
import { SYSTEM_LABELS, KIND_LABELS } from '../../shared/contract.js';

// W2-c 第 1 步：只有 /upload/ 下的受保护预览壳才去查后台全量账本（含 draft）。
// 前台首页 / 条目页不带这个路径 → 仍只拉公开的 /api/modules，访客看到的内容一字不变。
const ADMIN = location.pathname.startsWith('/upload/');
const API = ADMIN ? '/api/upload/admin/modules' : '/api/modules';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function encodeRelative(name) {
  return String(name).split('/').map(encodeURIComponent).join('/');
}

function coverUrl(mod) {
  if (!mod.cover) return '';
  if (/^https?:\/\//i.test(mod.cover)) return mod.cover;
  return mod.baseUrl + encodeRelative(mod.cover);
}

function cardHtml(mod) {
  // W3：卡片只留「封面 + 模组名」。规则 / 体量已在分区标题里，简介过长不进首页卡片。
  // 方案甲：封面用 object-fit: cover 轻微裁切填满 3:4；无封面时用规则名称占位，模组名照常显示。
  const cover = coverUrl(mod);
  const art = cover
    ? `<img class="card__art" src="${escapeHtml(cover)}" alt="封面" loading="lazy">`
    : `<span class="card__cover-ph">${escapeHtml(SYSTEM_LABELS[mod.system] ?? mod.system)}</span>`;
  return `<a class="card" href="/module.html?slug=${encodeURIComponent(mod.slug)}">
    <div class="card__cover">${art}</div>
    <div class="card__body"><h3 class="card__title">${escapeHtml(mod.title)}</h3></div>
  </a>`;
}

function renderHome(modules) {
  const app = document.getElementById('app');
  if (modules.length === 0) {
    app.innerHTML = '<p class="empty">目前还没有已发布的模组。</p>';
    return;
  }
  const sections = [];

  // DND 下按 kind 细分；其余规则按大区列卡片
  const dnd = modules.filter((m) => m.system === 'dnd');
  if (dnd.length) {
    let html = '<section class="section"><h2>DND</h2>';
    for (const kind of ['campaign', 'module', 'encounter']) {
      const group = dnd.filter((m) => m.kind === kind);
      if (!group.length) continue;
      html += `<h3>${escapeHtml(KIND_LABELS[kind])}</h3><div class="grid">${group.map(cardHtml).join('')}</div>`;
    }
    html += '</section>';
    sections.push(html);
  }

  for (const system of ['coc', 'other']) {
    const group = modules.filter((m) => m.system === system);
    if (!group.length) continue;
    sections.push(
      `<section class="section"><h2>${escapeHtml(SYSTEM_LABELS[system])}</h2>` +
      `<div class="grid">${group.map(cardHtml).join('')}</div></section>`,
    );
  }
  app.innerHTML = sections.join('');
}

function renderModule(modules, slug) {
  const app = document.getElementById('app');
  const mod = modules.find((m) => m.slug === slug);
  if (!mod) {
    app.innerHTML = `<div class="error-box">${ADMIN ? '找不到该条目。' : '找不到该条目，或它尚未发布（draft 不出现在浏览端）。'}</div>`;
    return;
  }
  document.title = `${mod.title} · TRPG 模组库`;
  // 两入口 URL 分别来自索引 consoleFile / mindmapFile，不硬编码文件名（中文原名保留）。
  // 草稿预览态里导图入口也走 /upload/ 受保护壳，否则它会去查公开列表而扑空。
  const mindmapUrl = `/${ADMIN ? 'upload/' : ''}mindmap.html?slug=${encodeURIComponent(mod.slug)}`;
  const consoleUrl = mod.baseUrl + encodeRelative(mod.consoleFile);
  const cover = coverUrl(mod);
  app.innerHTML = `
    <div class="module-head">
      <h2>${escapeHtml(mod.title)}</h2>
      <p class="meta">${escapeHtml(SYSTEM_LABELS[mod.system] ?? mod.system)} · ${escapeHtml(KIND_LABELS[mod.kind] ?? mod.kind)}</p>
      ${cover ? `<p class="meta"><img src="${escapeHtml(cover)}" alt="封面" style="max-width:220px;border-radius:8px"></p>` : ''}
      <p class="summary">${escapeHtml(mod.summary)}</p>
    </div>
    <div class="entries">
      <a class="entry" href="${escapeHtml(mindmapUrl)}" target="_blank" rel="noopener">
        <strong>思维导图</strong><small>在浏览器里查看</small>
      </a>
      <a class="entry" href="${escapeHtml(consoleUrl)}" target="_blank" rel="noopener">
        <strong>主控台</strong><small>打开模组原文与地图</small>
      </a>
    </div>
    <div class="notice">
      本站为公开只读索引，不列举、不推送资源包；原文与地图等文件仅由主控台内链接取用。<br>
      中文译文为<strong>非官方粉丝翻译，禁止商用</strong>，原译者声明与第三方物料声明在原文中完整保留。
    </div>`;
}

async function main() {
  const app = document.getElementById('app');
  try {
    const res = await fetch(API, { cache: 'no-store' });
    if (!res.ok) throw new Error(`列表接口返回 ${res.status}`);
    const data = await res.json();
    const modules = Array.isArray(data.modules) ? data.modules : [];
    if (document.body.dataset.page === 'module') {
      renderModule(modules, new URLSearchParams(location.search).get('slug') ?? '');
    } else {
      renderHome(modules);
    }
  } catch (err) {
    app.innerHTML = `<div class="error-box">载入失败：${escapeHtml(err.message)}。请稍后刷新重试。</div>`;
  }
}

main();
