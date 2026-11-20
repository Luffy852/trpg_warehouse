// 主控台 HTML 本地依赖解析唯一出处。
// 对应档案 §3.2「上架前校验」：依赖集合 = 两单文件原始名 + 拖拽树 relativePath 集合，
// 按主控台实际引用的本地路径逐项求包含；不预设必备文件名清单。
// 覆盖 href / src / iframe src / poster / data-src；绝对外链保持不动；
// 根相对 /... 单独登记（§0.6 未验风险），验出后再定是否需个别处理。

const REF_ATTR = /\b(?:href|src|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

// 扫描前只保留「真正的 HTML 标签」，把会拼页面的脚本体与注释挖空。
// 为什么：成品主控台的 <script> 里大量用模板字面量拼 DOM，例如
//   `<img class="thumb" src="${m[mapVer]}">`、`el.src=m[ver];`
// `${...}` / `m[ver]` 是运行时才有的值，不是文件名；若被 REF_ATTR 当成依赖，
// 上架会误报 MISSING_DEPS（W1 #5 真实缺陷，完整样板实测 local 5 → 1）。
// 关键约束：<script> 的**开标签必须保留** —— 开标签上的 src 是真实静态引用
// （现有单测与冒烟都断言要抓到 <script src="assets/app.js">）。
// <template> 不在挖空范围：它内部是真实静态 HTML，克隆后引用照样生效。
function stripNonHtmlBodies(html) {
  const source = String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' ');
  // 没有任何闭合 script 时，浏览器也会把其后全部当脚本，一并挖到末尾
  if (!/<\/script\s*>/i.test(source)) {
    return source.replace(/(<script\b[^>]*>)[\s\S]*$/i, (_m, open) => `${open}`);
  }
  return source.replace(
    /(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi,
    (_m, open, close) => `${open} ${close}`,
  );
}

function normalizeRefPath(path) {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // 非法百分号编码：保留原样，交由后续集合比对，不擅自改写
  }
  decoded = decoded.replace(/\\/g, '/');
  const out = [];
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null; // 越出条目根，可疑，忽略
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function dedupe(list) {
  return [...new Set(list)];
}

export function extractReferences(html) {
  const result = { local: [], external: [], rootRelative: [], ignored: [] };
  const source = stripNonHtmlBodies(html);
  for (const match of source.matchAll(REF_ATTR)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!value) {
      result.ignored.push(value);
      continue;
    }
    // 兜底：即便出现在非 script 区域，未求值的模板占位符也不是文件名
    if (value.includes('${')) {
      result.ignored.push(value);
      continue;
    }
    if (/^(?:javascript|data|mailto|tel|about|blob):/i.test(value) || value.startsWith('#')) {
      result.ignored.push(value);
      continue;
    }
    if (/^https?:\/\//i.test(value) || value.startsWith('//')) {
      result.external.push(value);
      continue;
    }
    const path = value.split(/[?#]/)[0];
    if (!path) {
      result.ignored.push(value);
      continue;
    }
    if (path.startsWith('/')) {
      result.rootRelative.push(path);
      continue;
    }
    const normalized = normalizeRefPath(path);
    if (!normalized) {
      result.ignored.push(value);
      continue;
    }
    result.local.push(normalized);
  }
  result.local = dedupe(result.local);
  result.external = dedupe(result.external);
  result.rootRelative = dedupe(result.rootRelative);
  return result;
}

export function buildAvailableSet(consoleFile, mindmapFile, relativePaths = []) {
  return new Set([consoleFile, mindmapFile, ...relativePaths]);
}

export function findMissingDeps(references, availableSet) {
  const local = Array.isArray(references) ? references : references.local;
  return local.filter((ref) => !availableSet.has(ref));
}
