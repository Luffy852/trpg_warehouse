// W2-c · 模组管理台：受保护的全量账本（含草稿）+ 顶部校准模块。
// 五列纵向一行一模组；排序 / 标签 / 按钮态 / 删除确认全部走 shared/admin.js 唯一口径。
// 第 1 步亮上架、第 2 步亮下架（可逆）、第 3 步亮删除（不可逆、手打 slug 确认）。
// 顶部模块横向列出「校准按钮 / 仓库规模 / 上次校准」：显示的是上次校准留下的静态快照，
// 页面访问只读一行 D1、绝不翻仓库；只有手动点「校准」才会重算并同时更新账本与显示值。
// 「预览页 / 条目页」同一个按钮位按状态二态，一律新标签打开（用户 R6-3 / R7-2）。
// 源码在这里，产物是 web/vendor/admin.js（esbuild 打包，随仓库提交）。
import {
  systemKindLabel,
  statusLabel,
  adminRowActions,
  previewTarget,
  deleteConfirmMessage,
  matchesDeleteConfirm,
} from '../../shared/admin.js';

const app = document.getElementById('adminApp');
let rows = [];
let storage = null;
let notice = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// D1 记的是 UTC 时间；按浏览器本地时区显示，避免看到的钟点对不上
function formatCalibratedAt(value) {
  if (!value) return '尚未校准';
  const date = new Date(String(value).replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function storageHtml() {
  const size = storage ? formatBytes(storage.totalBytes) : '—';
  const date = storage ? formatCalibratedAt(storage.calibratedAt) : '尚未校准';
  return `<div class="admin-storage">
    <button type="button" class="btn btn--sm" data-action="calibrate">校准</button>
    <span class="admin-storage__item">仓库规模 <strong>${escapeHtml(size)}</strong></span>
    <span class="admin-storage__item">上次校准 <strong>${escapeHtml(date)}</strong></span>
  </div>`;
}

function rowHtml(m) {
  const actions = adminRowActions(m.status);
  const preview = previewTarget(m.slug, m.status);
  // slug 只是「唯一 ID」，纯文本展示、没有任何 input / 编辑入口（用户 R4-2）
  return `<tr>
    <td>${escapeHtml(m.title)}</td>
    <td class="slug-cell">${escapeHtml(m.slug)}</td>
    <td>${escapeHtml(systemKindLabel(m.system, m.kind))}</td>
    <td>${escapeHtml(statusLabel(m.status))}</td>
    <td>
      <div class="row-actions">
        <a class="btn btn--sm" href="${escapeHtml(preview)}" target="_blank" rel="noopener">${escapeHtml(actions.previewLabel)}</a>
        <button type="button" class="btn btn--sm" data-action="publish" data-slug="${escapeHtml(m.slug)}" data-title="${escapeHtml(m.title)}"${actions.publishEnabled ? '' : ' disabled'}>上架</button>
        <button type="button" class="btn btn--sm" data-action="unpublish" data-slug="${escapeHtml(m.slug)}" data-title="${escapeHtml(m.title)}"${actions.unpublishEnabled ? '' : ' disabled'}>下架</button>
        <button type="button" class="btn btn--sm" data-action="delete" data-slug="${escapeHtml(m.slug)}" data-title="${escapeHtml(m.title)}" data-status="${escapeHtml(m.status)}"${actions.removeEnabled ? '' : ' disabled'}>删除</button>
      </div>
    </td>
  </tr>`;
}

function render() {
  const noticeHtml = notice
    ? `<div class="result ${notice.bad ? 'bad' : 'ok'}">${escapeHtml(notice.text)}</div>`
    : '';
  const table = rows.length
    ? `<div class="admin-table-wrap"><table class="admin-table">
        <thead><tr><th>模组名</th><th>slug</th><th>规则及体量</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${rows.map(rowHtml).join('')}</tbody>
       </table></div>`
    : '<p class="empty">仓库里还没有任何模组。</p>';
  app.innerHTML = storageHtml() + noticeHtml + table;
}

function setNotice(text, bad = false) {
  notice = { text, bad };
  render();
}

async function load() {
  try {
    const data = await fetchJSON('/api/upload/admin/modules');
    rows = Array.isArray(data.modules) ? data.modules : [];
    storage = data.storage ?? null;
    render();
  } catch (err) {
    rows = [];
    storage = null;
    setNotice(`载入模组列表失败：${err.message}`, true);
  }
}

async function postAdmin(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data;
}

// 「回执成功」≠「浏览端真的变化」：上架 / 下架后都重新拉公开列表做行为断言（P-05 / V-01）。
async function publish(slug, title) {
  if (!confirm(`确定把「${title}」上架到公开浏览端吗？`)) return;
  setNotice(`正在上架 ${slug} …`);
  try {
    const before = await fetchJSON('/api/modules');
    const baseline = (before.modules ?? []).length;
    const data = await postAdmin('/api/upload/admin/publish', { slug });
    if (data.status !== 'published') throw new Error('上架回执状态不是 published');

    const after = await fetchJSON('/api/modules');
    const list = after.modules ?? [];
    const failures = [];
    if (list.length !== baseline + 1) {
      failures.push(`期望 ${baseline + 1} 张卡片，实际 ${list.length} 张`);
    }
    if (!list.some((m) => m.slug === slug)) {
      failures.push(`浏览端列表里找不到 ${slug}`);
    }
    if (failures.length) {
      setNotice(`状态已写入，但浏览端未按预期变化：${failures.join('；')}`, true);
      return;
    }
    setNotice(`上架成功：${slug} · 浏览端卡片 +1（${baseline} → ${list.length}）`);
    await load();
  } catch (err) {
    setNotice(`上架失败：${err?.message ?? String(err)}`, true);
  }
}

async function unpublish(slug, title) {
  if (!confirm(`确定把「${title}」下架吗？\n浏览端将不再显示；文件仍保留，随时可以重新上架。`)) return;
  setNotice(`正在下架 ${slug} …`);
  try {
    const before = await fetchJSON('/api/modules');
    const baseline = (before.modules ?? []).length;
    const data = await postAdmin('/api/upload/admin/unpublish', { slug });
    if (data.status !== 'draft') throw new Error('下架回执状态不是 draft');

    const after = await fetchJSON('/api/modules');
    const list = after.modules ?? [];
    const failures = [];
    if (list.length !== baseline - 1) {
      failures.push(`期望 ${baseline - 1} 张卡片，实际 ${list.length} 张`);
    }
    if (list.some((m) => m.slug === slug)) {
      failures.push(`浏览端列表里仍能看到 ${slug}`);
    }
    if (failures.length) {
      setNotice(`状态已写入，但浏览端未按预期变化：${failures.join('；')}`, true);
      return;
    }
    setNotice(`下架成功：${slug} · 浏览端卡片 -1（${baseline} → ${list.length}）。文件仍保留，点「上架」即可恢复发布。`);
    await load();
  } catch (err) {
    setNotice(`下架失败：${err?.message ?? String(err)}`, true);
  }
}

// 删除不可逆：手打 slug 确认（Worker 侧还会再验一次），已发布多一句对外展示提示。
async function remove(slug, status) {
  const typed = prompt(deleteConfirmMessage(slug, status));
  if (typed === null) return;
  if (!matchesDeleteConfirm(slug, typed)) {
    setNotice('手打的 slug 与条目不一致，未删除。', true);
    return;
  }
  setNotice(`正在删除 ${slug} …`);
  try {
    const before = await fetchJSON('/api/modules');
    const baseline = (before.modules ?? []).length;
    const data = await postAdmin('/api/upload/admin/delete', { slug, confirmSlug: typed });

    const after = await fetchJSON('/api/modules');
    const list = after.modules ?? [];
    const admin = await fetchJSON('/api/upload/admin/modules');
    const adminRows = admin.modules ?? [];
    const failures = [];
    const wasPublic = status === 'published';
    const expected = wasPublic ? baseline - 1 : baseline;
    if (list.length !== expected) {
      failures.push(`期望 ${expected} 张公开卡片，实际 ${list.length} 张`);
    }
    if (list.some((m) => m.slug === slug)) {
      failures.push(`公开列表里仍能看到 ${slug}`);
    }
    if (adminRows.some((m) => m.slug === slug)) {
      failures.push(`管理台里仍能看到 ${slug}`);
    }
    if (failures.length) {
      setNotice(`资料卡已删，但列表未按预期变化：${failures.join('；')}`, true);
      return;
    }
    setNotice(
      `删除成功：${slug} · 清掉 ${data.deletedObjects ?? 0} 个仓库文件、资料卡已移除。` +
      (wasPublic ? `公开卡片 ${baseline} → ${list.length}。` : ''),
    );
    await load();
  } catch (err) {
    setNotice(`删除失败：${err?.message ?? String(err)}`, true);
  }
}

// 校准：按钮本身就是手动确认，点一次当场翻一次仓库；
// 先清掉没索引的垃圾对象，再更新账本，最后刷新顶部静态值。
async function calibrate() {
  setNotice('正在校准…');
  try {
    const data = await postAdmin('/api/upload/admin/calibrate');
    setNotice(
      `校准完成：仓库规模 ${formatBytes(data.totalBytes)} · 账本已对齐 · ` +
      `清掉 ${data.deletedOrphans ?? 0} 个无索引对象 · ` +
      `清理 ${data.clearedLocks ?? 0} 条旧预留 · 本项目现存 ${data.objectCount ?? 0} 个模组文件`,
    );
    await load();
  } catch (err) {
    setNotice(`校准失败：${err?.message ?? String(err)}`, true);
  }
}

app.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-action]');
  if (!btn || btn.disabled) return;
  const { action, slug, title, status } = btn.dataset;
  if (action === 'publish') publish(slug, title);
  else if (action === 'unpublish') unpublish(slug, title);
  else if (action === 'delete') remove(slug, status);
  else if (action === 'calibrate') calibrate();
});

load();
