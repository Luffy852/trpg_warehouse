// 上传端：三区输入 → 本地预检 → prepare（Worker 权威校验 + 预签名）→ 浏览器直传 R2
//        → finalize（写 D1）→ 重新拉列表断言「卡片 +1」，通过才显示上架成功。
// 源码在这里，产物是 web/vendor/upload.js（esbuild 打包，随仓库提交）。
import { slugify, validateMeta } from '../../shared/contract.js';
import {
  stripTopFolder,
  isUnsafeRelativePath,
  findDuplicateNames,
  buildUploadPlan,
  skipSingleFileDuplicates,
} from '../../shared/paths.js';
import { extractReferences, buildAvailableSet, findMissingDeps } from '../../shared/deps.js';
import { COST_GUARD_DEFAULTS, validateSizes } from '../../shared/cost.js';

const $ = (id) => document.getElementById(id);

// 拖拽树：[{ file, relativePath }]，relativePath 已剥掉所选顶层文件夹名
let treeFiles = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ①②区可能后选 / 改选，所以每次都按「当前」两个单文件重算，不把剔除结果写死在 setTree。
function currentSingleNames() {
  return {
    consoleFile: $('consoleFile').files[0]?.name ?? '',
    mindmapFile: $('mindmapFile').files[0]?.name ?? '',
  };
}

// 包①b：只跳过与两单文件完全同名的资源树项。返回剔除后的 treeFiles 供下游全链使用
// （sizes / 依赖断言 / buildUploadPlan / relativePaths / fileMap / prepare 请求）。
function skippedNames(files) {
  const { consoleFile, mindmapFile } = currentSingleNames();
  return skipSingleFileDuplicates(
    consoleFile, mindmapFile, files.map((x) => x.relativePath),
  ).skipped;
}

function effectiveTree() {
  const skip = new Set(skippedNames(treeFiles));
  return treeFiles.filter((x) => !skip.has(x.relativePath));
}

// 显式回执：树摘要当场写明「跳过了哪几个」，不静默丢弃。
function renderTreeSummary() {
  const names = treeFiles.slice(0, 6).map((x) => x.relativePath).join('、');
  let text = treeFiles.length
    ? `已选择 ${treeFiles.length} 个文件：${names}${treeFiles.length > 6 ? ' …' : ''}`
    : '尚未选择资源树。';
  const skipped = [...new Set(skippedNames(treeFiles))];
  if (skipped.length) {
    text += `；已跳过 ${skipped.length} 个与 ①/② 区同名的文件：${skipped.join('、')}（以单文件区为准，不重复上传）`;
  }
  $('treeSummary').textContent = text;
}

function setTree(files) {
  treeFiles = files;
  renderTreeSummary();
}

// 「清空已选」：只清资源树（拖拽 + 按钮选择共用同一份 treeFiles），不动两个单文件区。
// 配合下面的同名拒绝文案：撞了重名可以一键重来，改选不含两单文件的文件夹即可。
function clearTree() {
  treeFiles = [];
  $('treeInput').value = '';
  renderTreeSummary();
}
$('clearTreeBtn').addEventListener('click', clearTree);
// ①②区改选单文件后，跳过名单随之变化，摘要立即重算。
$('consoleFile').addEventListener('change', renderTreeSummary);
$('mindmapFile').addEventListener('change', renderTreeSummary);

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

// 体积声明随 prepare 送给 Worker；finalize 会用 R2 head().size 复核，少报会被抓到。
// 传入的是剔除后的树：被跳过的冗余副本不重复计体积、也不重复 PUT。
function collectSizes(meta, tree) {
  const sizes = {};
  const consoleFile = $('consoleFile').files[0];
  const mindmapFile = $('mindmapFile').files[0];
  if (consoleFile) sizes[meta.consoleFile] = consoleFile.size;
  if (mindmapFile) sizes[meta.mindmapFile] = mindmapFile.size;
  for (const x of tree) {
    if (!(x.relativePath in sizes)) sizes[x.relativePath] = x.file.size;
  }
  return sizes;
}

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

  // 包①b：与 ①/② 区完全同名的资源树项已显式跳过（树摘要里写明），
  // 下面所有校验都基于剔除后的树，不重复计体积、不重复 PUT。
  const effective = effectiveTree();
  const skipped = skippedNames(treeFiles);
  const rels = effective.map((x) => x.relativePath);
  for (const p of [meta.consoleFile, meta.mindmapFile, ...rels]) {
    if (p && isUnsafeRelativePath(p)) errors.push(`路径不安全：${p}`);
  }
  // 仍严格拒绝：两单文件互相同名、资源树内自身重名（同一文件夹拖两次）、路径不安全、缺依赖。
  // findDuplicateNames 本身未改，Worker 收到的也是剔除后的 relativePaths，仍 fail-closed 兜底。
  const duplicates = findDuplicateNames(meta.consoleFile, meta.mindmapFile, rels);
  if (duplicates.length) {
    errors.push(...duplicates);
    errors.push(
      '处理方式：与 ①/② 区同名的文件已自动跳过；这里剩下的是两单文件互相同名，或资源树内自身重名' +
      '（同一文件夹可能拖了两次）。前者请改选其中一个单文件，后者点「清空已选资源树」后只选一次。' +
      '其余同名一律拒绝，不会自动覆盖。',
    );
  }

  let refs = { local: [], external: [], rootRelative: [] };
  if ($('consoleFile').files[0]) {
    refs = extractReferences(await $('consoleFile').files[0].text());
    const missing = findMissingDeps(
      refs,
      buildAvailableSet(meta.consoleFile, meta.mindmapFile, rels),
    );
    for (const name of missing) errors.push(`主控台引用的本地文件缺失：${name}`);
  }

  const sizes = collectSizes(meta, effective);
  // 前端用默认阈值提前反馈；若你在 wrangler.toml 改过阈值，以 Worker 权威校验为准。
  const plan = buildUploadPlan(meta.slug || '_', meta.consoleFile, meta.mindmapFile, rels);
  errors.push(...validateSizes({ sizes, plan, guards: COST_GUARD_DEFAULTS }).errors);
  return { errors, refs, rels, sizes, skipped, effective };
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
    const { errors, refs, rels, sizes, skipped, effective } = await precheck(meta);
    if (errors.length) return showBad('本地预检未通过，未发起上架', errors);

    const consoleHtml = await $('consoleFile').files[0].text();

    // 行为断言基线：上架前先记下浏览端卡片数
    const before = await fetchJSON('/api/modules');
    const baseline = (before.modules ?? []).length;

    const prep = await postJSON('/api/upload/prepare', {
      ...meta,
      consoleHtml,
      relativePaths: rels,
      sizes,
    });
    if (!prep.httpOk) {
      return showBad('Worker 拒绝上架', [prep.error ?? `HTTP ${prep.httpStatus}`, ...(prep.details ?? [])]);
    }

    const fileMap = new Map();
    fileMap.set(meta.consoleFile, $('consoleFile').files[0]);
    fileMap.set(meta.mindmapFile, $('mindmapFile').files[0]);
    for (const x of effective) {
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
        ...(skipped.length
          ? [`已跳过 ${skipped.length} 个与 ①/② 区同名的资源树文件：${[...new Set(skipped)].join('、')}（以单文件区为准，不重复上传）`]
          : []),
        `已写入对象 ${fin.objectCount} 个 / ${((fin.totalBytes ?? 0) / 1024 / 1024).toFixed(1)} MB，D1 写后读回校验通过`,
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
