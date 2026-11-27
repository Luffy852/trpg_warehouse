// D 段 D-08：四个前端入口（app / mindmap-app / admin-app / upload-app）原先各写一份
// escapeHtml / fetchJSON / encodeRelative，属「同一份实现写四遍」（原则 4 / 原则 7）。
// 现在抽到唯一出处，由 esbuild 打包时内联进各 vendor；函数体逐字不变，外部行为不变。
// encodeRelative 与 shared/paths.js 的 encodeKeyPath 完全等价 → 直接同源导出，不留第二份实现。
export { encodeKeyPath as encodeRelative } from './paths.js';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
