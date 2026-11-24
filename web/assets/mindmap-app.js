// xmind 预览：全部发生在访客浏览器，不经过 Worker、不生成第二份 HTML/SVG 副本。
// 链路：fetch ArrayBuffer → fflate 解 ZIP → 优先 content.json / 回退 content.xml
//       → @mind-elixir/import-xmind 转节点树 → mind-elixir 只读画布。
// 源码在这里，产物是 web/vendor/mindmap.js（esbuild 打包，随仓库提交）。
import { unzipSync } from 'fflate';
import MindElixir from 'mind-elixir';
import { importXMindFile, convertXmindToMindElixir } from '@mind-elixir/import-xmind';
import { inspectXmind } from '../../shared/xmind.js';

const statusEl = document.getElementById('status');
const sheetsEl = document.getElementById('sheets');
const fallbackEl = document.getElementById('fallback');
const downloadEl = document.getElementById('download');
const detailEl = document.getElementById('detail');
const mapEl = document.getElementById('map');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function encodeRelative(name) {
  return String(name).split('/').map(encodeURIComponent).join('/');
}

// 任何失败都给可见提示 + 下载原文件链接，绝不留白屏（原则 2 / P-03）
function fail(message, detail) {
  statusEl.textContent = `✕ ${message}`;
  statusEl.classList.add('error');
  fallbackEl.hidden = false;
  detailEl.textContent = detail ? `诊断：${detail}` : '';
}

async function main() {
  const slug = new URLSearchParams(location.search).get('slug');
  if (!slug) return fail('缺少 slug 参数');
  downloadEl.href = `/api/download?slug=${encodeURIComponent(slug)}&file=mindmap`;

  let mod;
  try {
    const res = await fetch('/api/modules', { cache: 'no-store' });
    if (!res.ok) throw new Error(`索引接口 HTTP ${res.status}`);
    const data = await res.json();
    mod = (data.modules ?? []).find((m) => m.slug === slug);
    if (!mod) throw new Error('索引里找不到该条目（可能是 draft 或尚未上架）');
  } catch (err) {
    return fail('无法读取条目索引', err.message);
  }

  const fileUrl = mod.baseUrl + encodeRelative(mod.mindmapFile);
  let buffer;
  try {
    const res = await fetch(fileUrl, { mode: 'cors', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buffer = await res.arrayBuffer();
  } catch (err) {
    return fail('无法读取 .xmind 原文件（检查 R2 自定义域与 CORS GET 配置）', err.message);
  }

  // 自己解一次 ZIP：做格式判定、加密/损坏检测、占位 XML 识别，再交给库转换
  let entries;
  try {
    entries = unzipSync(new Uint8Array(buffer));
  } catch (err) {
    return fail('文件不是有效的 .xmind（ZIP 解析失败，可能是密码保护或损坏文件）', err.message);
  }

  // 有 content.json 优先；只有「请升级」占位 content.xml 会直接给可见错误，不留空图
  const inspected = inspectXmind(entries);
  if (!inspected.ok) return fail(inspected.reason);
  const formatLabel = inspected.label;

  let sheets;
  try {
    const file = new File([buffer], mod.mindmapFile, { type: 'application/vnd.xmind.workbook' });
    sheets = await importXMindFile(file);
  } catch (err) {
    return fail('导图解析失败（加密 / 损坏 / 格式不受支持）', String(err?.message ?? err ?? '未知错误'));
  }
  if (!Array.isArray(sheets) || sheets.length === 0) {
    return fail('解析结果为空，未拿到任何工作表');
  }

  statusEl.textContent = `✓ ${formatLabel} · ${sheets.length} 个工作表 · 只读预览（Ctrl / ⌘ + 滚轮缩放 / 拖拽平移 / 点击折叠）`;
  statusEl.classList.remove('error');
  fallbackEl.hidden = true;

  const mind = new MindElixir({
    el: mapEl,
    direction: MindElixir.SIDE,
    editable: false,
    contextMenu: false,
    keypress: false,
    allowUndo: false,
    toolBar: true,
    overflowHidden: false,
    // 缩放步进须落在库的 scaleMin=0.2 ~ scaleMax=1.4 区间内：旧步进 1 会让
    // 右下角 +/- 求 scale(2)/scale(0)，Ctrl/⌘+滚轮同理，都被上下限直接拦掉。
    // 保留库默认输入通路（按键+滚轮缩放 / 普通滚轮与拖动平移 / 双指 pinch），不接管 handleWheel。
    scaleSensitivity: 0.1,
  });

  mind.init(convertXmindToMindElixir(sheets[0]));

  if (sheets.length > 1) {
    sheetsEl.hidden = false;
    sheetsEl.innerHTML = sheets
      .map((sheet, i) =>
        `<button class="sheet-tab${i === 0 ? ' active' : ''}" data-i="${i}">${escapeHtml(sheet.title || `工作表 ${i + 1}`)}</button>`,
      )
      .join('');
    sheetsEl.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-i]');
      if (!btn) return;
      const index = Number(btn.dataset.i);
      mind.refresh(convertXmindToMindElixir(sheets[index]));
      for (const tab of sheetsEl.querySelectorAll('button')) {
        tab.classList.toggle('active', Number(tab.dataset.i) === index);
      }
    });
  }
}

main();
