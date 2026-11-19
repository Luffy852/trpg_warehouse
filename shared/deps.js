// 主控台 HTML 本地依赖解析唯一出处。
// 对应档案 §3.2「上架前校验」：依赖集合 = 两单文件原始名 + 拖拽树 relativePath 集合，
// 按主控台实际引用的本地路径逐项求包含；不预设必备文件名清单。
// 覆盖 href / src / iframe src / poster / data-src；绝对外链保持不动；
// 根相对 /... 单独登记（§0.6 未验风险），验出后再定是否需个别处理。

const REF_ATTR = /\b(?:href|src|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

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
  const source = String(html ?? '');
  for (const match of source.matchAll(REF_ATTR)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!value) {
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
