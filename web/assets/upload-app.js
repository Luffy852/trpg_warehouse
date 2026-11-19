// 上传端：三区输入 → 本地预检 → prepare（Worker 权威校验 + 预签名）→ 浏览器直传 R2
//        → finalize（写 D1）→ 重新拉列表断言「卡片 +1」，通过才显示上架成功。
// 源码在这里，产物是 web/vendor/upload.js（esbuild 打包，随仓库提交）。
import { slugify, validateMeta } from '../../shared/contract.js';
import {
  stripTopFolder,
  isUnsafeRelativePath,
  findDuplicateNames,
} from '../../shared/paths.js';
import { extractReferences, buildAvailableSet, findMissingDeps } from '../../shared/deps.js';

const $ = (id) => document.getElementById(id);

// 拖拽树：[{ file, relativePath }]，relativePath 已剥掉所选顶层文件夹名
let treeFiles = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function setTree(files) {
  treeFiles = files;
  const names = files.slice(0, 6).map((x) => x.relativePath).join('、');
  $('treeSummary').textContent = files.length
    ? `已选择 ${files.length} 个文件：${names}${files.length > 6 ? ' …' : ''}`
    : '尚未选择资源树。';
}

// webkitdirectory：webkitRelativePath 形如「顶层文件夹/子/文件」，剥掉第一段
$('treeInput').addEventListener('change', (event) => {
  const list = Array.from(event.target.files || []);
  const top = list.length ? (list[0].webkitRelativePath || '').split('/')[0] || null : null;
  setTree(
    list
      .map((file) => ({
        file,
        relativePath: stripTopFolder(file.webkitRelativePath || file.name, top),
      }))
      .filter((x) => x.relativePath),
  );
});

// drop：递归读 DataTransferItem.webkitGetAsEntry()，支持多文件夹 + 散文件混拖
async function readEntry(entry, prefix, out) {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, relativePath: path });
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await readEntry(child, path, out);
    }
  }
}

const dropZone = $('dropZone');
dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', async (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragover');
  const out = [];
  for (const item of Array.from(event.dataTransfer.items || [])) {
    const entry = item.webkitGetAsEntry?.();
    if (!entry) continue;
    const tmp = [];
    await readEntry(entry, '', tmp);
    const top = entry.isDirectory ? entry.name : null;
    for (const x of tmp) {
      const relativePath = stripTopFolder(x.relativePath, top);
      if (relativePath) out.push({ file: x.file, relativePath });
    }
  }
  // 混拖散文件 + 多文件夹：追加到已选树；重名由预检拒绝，不静默覆盖
  setTree([...treeFiles, ...out]);
});

function readForm() {
  const title = $('title').value.trim();
  return {
    title,
    slug: slugify($('slug').value.trim() || title),
    system: $('system').value,
    kind: $('kind').value,
    status: $('status').value,
    summary: $('summary').value.trim(),
    cover: $('cover').value.trim(),
    consoleFile: $('consoleFile').files[0]?.name ?? '',
    mindmapFile: $('mindmapFile').files[0]?.name ?? '',
  };
}

async function precheck(meta) {
  let errors = validateMeta(meta);
  if (!meta.slug) {
    errors = errors
      .filter((e) => !e.startsWith('slug'))
      .concat('标题不含英文字母，请手动填写 slug（英文小写短横线，如 frozen-malice）');
  }
  if (!meta.consoleFile) errors.push('请选择主控台单文件');
  if (!meta.mindmapFile) errors.push('请选择思维导图单文件');

  const rels = treeFiles.map((x) => x.relativePath);
  for (const p of [meta.consoleFile, meta.mindmapFile, ...rels]) {
    if (p && isUnsafeRelativePath(p)) errors.push(`路径不安全：${p}`);
  }
  errors.push(...findDuplicateNames(meta.consoleFile, meta.mindmapFile, rels));

  let refs = { local: [], external: [], rootRelative: [] };
  if ($('consoleFile').files[0]) {
    refs = extractReferences(await $('consoleFile').files[0].text());
    const missing = findMissingDeps(
      refs,
      buildAvailableSet(meta.consoleFile, meta.mindmapFile, rels),
    );
    for (const name of missing) errors.push(`主控台引用的本地文件缺失：${name}`);
  }
  return { errors, refs, rels };
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ...data, httpOk: res.ok, httpStatus: res.status };
}

// 预签名直传：不手动 setRequestHeader('Content-Type')，避免签名不匹配
function putFile(url, file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`PUT 返回 ${xhr.status}（检查 R2 CORS 与预签名是否过期）`));
    xhr.onerror = () => reject(new Error('直传网络错误'));
    xhr.send(file);
  });
}

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await fn(items[cursor++]);
  });
  await Promise.all(workers);
}

function setProgress(done, total, label) {
  $('progress').hidden = false;
  $('progressText').textContent = `${label} ${done}/${total}`;
  $('progressBar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
}

function showBad(title, lines) {
  const box = $('result');
  box.className = 'result bad';
  box.hidden = false;
  box.innerHTML =
    `<strong>${escapeHtml(title)}</strong>` +
    (lines.length ? `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : '');
}

function showOk(title, lines, linkHtml) {
  const box = $('result');
  box.className = 'result ok';
  box.hidden = false;
  box.innerHTML =
    `<strong>${escapeHtml(title)}</strong>` +
    (lines.length ? `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : '') +
    (linkHtml ?? '');
}

async function submit() {
  const btn = $('submitBtn');
  btn.disabled = true;
  $('result').hidden = true;
  setProgress(0, 1, '本地预检…');
  try {
    const meta = readForm();
    const { errors, refs, rels } = await precheck(meta);
    if (errors.length) return showBad('本地预检未通过，未发起上架', errors);

    const consoleHtml = await $('consoleFile').files[0].text();

    // 行为断言基线：上架前先记下浏览端卡片数
    const before = await fetchJSON('/api/modules');
    const baseline = (before.modules ?? []).length;

    const prep = await postJSON('/api/upload/prepare', {
      ...meta,
      consoleHtml,
      relativePaths: rels,
    });
    if (!prep.httpOk) {
      return showBad('Worker 拒绝上架', [prep.error ?? `HTTP ${prep.httpStatus}`, ...(prep.details ?? [])]);
    }

    const fileMap = new Map();
    fileMap.set(meta.consoleFile, $('consoleFile').files[0]);
    fileMap.set(meta.mindmapFile, $('mindmapFile').files[0]);
    for (const x of treeFiles) {
      if (!fileMap.has(x.relativePath)) fileMap.set(x.relativePath, x.file);
    }

    let done = 0;
    setProgress(0, prep.uploads.length, '正在直传资源…');
    await mapLimit(prep.uploads, 4, async (item) => {
      const file = fileMap.get(item.relativePath);
      if (!file) throw new Error(`找不到本地文件：${item.relativePath}`);
      await putFile(item.url, file);
      setProgress(++done, prep.uploads.length, '正在直传资源…');
    });

    setProgress(prep.uploads.length, prep.uploads.length, '写入索引…');
    const fin = await postJSON('/api/upload/finalize', { token: prep.token, slug: prep.slug });
    if (!fin.httpOk || fin.ok !== true) {
      return showBad('上架未完成', [fin.error ?? `HTTP ${fin.httpStatus}`, ...(fin.details ?? [])]);
    }

    // 关键断言（P-05 / V-01）：上传回执成功 ≠ 浏览端多了一张卡，必须重新拉列表核实
    const after = await fetchJSON('/api/modules');
    const list = after.modules ?? [];
    const published = meta.status === 'published';
    const expected = published ? baseline + 1 : baseline;
    const present = list.some((m) => m.slug === prep.slug);
    if (list.length !== expected || present !== published) {
      return showBad('索引未更新：上传回执成功但浏览端卡片数未变化', [
        `期望 ${expected} 张卡片，实际 ${list.length}；slug 是否出现＝${present}`,
      ]);
    }

    showOk(
      published
        ? `上架成功：${prep.slug} · 浏览端卡片 +1（${baseline} → ${list.length}）`
        : `草稿已保存：${prep.slug} · 浏览端不出现（卡片数不变）`,
      [
        `主控台实际引用 ${refs.local.length} 个本地资源，均已在包内`,
        `绝对外链 ${refs.external.length} 个保持原样，不纳入存在性断言`,
        `已写入对象 ${fin.objectCount} 个，D1 写后读回校验通过`,
        ...(refs.rootRelative.length
          ? [`⚠ 检出根相对路径 ${refs.rootRelative.join('、')}，属 §0.6 未验风险，请真机确认是否可达`]
          : []),
        ...((prep.checks?.rootRelativeRefs ?? []).length
          ? [`⚠ Worker 同样检出根相对路径：${prep.checks.rootRelativeRefs.join('、')}`]
          : []),
      ],
      `<p style="margin-top:10px"><a href="/module.html?slug=${encodeURIComponent(prep.slug)}">打开条目页 →</a></p>`,
    );
  } catch (err) {
    showBad('上架过程中出错', [err?.message ?? String(err)]);
  } finally {
    btn.disabled = false;
  }
}

$('submitBtn').addEventListener('click', submit);
