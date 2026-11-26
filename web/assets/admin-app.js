// W2-c 第 1 步 · 模组管理台：受保护的全量账本（含草稿）。
// 五列纵向一行一模组；排序 / 标签 / 按钮态全部走 shared/admin.js 唯一口径，这里不排第二份。
// 本步只亮「上架」：「下架 / 删除」灰着不可点、不加额外注释（用户 R5-3）。
// 源码在这里，产物是 web/vendor/admin.js（esbuild 打包，随仓库提交）。
import { systemKindLabel, statusLabel, adminRowActions, previewTarget } from '../../shared/admin.js';

const app = document.getElementById('adminApp');
let rows = [];
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
        <a class="btn btn--sm" href="${escapeHtml(preview)}">${escapeHtml(actions.previewLabel)}</a>
        <button type="button" class="btn btn--sm" data-action="publish" data-slug="${escapeHtml(m.slug)}" data-title="${escapeHtml(m.title)}"${actions.publishEnabled ? '' : ' disabled'}>上架</button>
        <button type="button" class="btn btn--sm" disabled>下架</button>
        <button type="button" class="btn btn--sm" disabled>删除</button>
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
  app.innerHTML = noticeHtml + table;
}

function setNotice(text, bad = false) {
  notice = { text, bad };
  render();
}

async function load() {
  try {
    const data = await fetchJSON('/api/upload/admin/modules');
    rows = Array.isArray(data.modules) ? data.modules : [];
    render();
  } catch (err) {
    rows = [];
    setNotice(`载入模组列表失败：${err.message}`, true);
  }
}

// 「回执成功」≠「浏览端多了一张卡」：上架后重新拉公开列表做行为断言（P-05 / V-01）。
async function publish(slug, title) {
  if (!confirm(`确定把「${title}」上架到公开浏览端吗？`)) return;
  setNotice(`正在上架 ${slug} …`);
  try {
    const before = await fetchJSON('/api/modules');
    const baseline = (before.modules ?? []).length;

    const res = await fetch('/api/upload/admin/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok !== true || data.status !== 'published') {
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }

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
    await load(); // 刷新管理台，该行状态随之更新（文案由 statusLabel 统一给）
  } catch (err) {
    setNotice(`上架失败：${err?.message ?? String(err)}`, true);
  }
}

app.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-action="publish"]');
  if (!btn || btn.disabled) return;
  publish(btn.dataset.slug, btn.dataset.title);
});

load();
