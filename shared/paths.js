// 路径规则唯一出处。对应档案 §0.4「拖拽目录语义」「资源路由适配」、
// §3.2「relativePath 规则」「R2 key」「重名冲突」。
// 铁律：剥掉所选顶层文件夹名，其余整树原样保留；不摊平、不重排、不改名。

// 若第一段 == 用户所选顶层文件夹名，则剥掉它；散拖文件保持自身文件名。
export function stripTopFolder(relativePath, topFolderName) {
  const parts = String(relativePath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/');
  if (topFolderName && parts[0] === topFolderName) return parts.slice(1).join('/');
  return parts.join('/');
}

// R2 没有「目录对象」，目录只是 key 前缀，天然保住目录格局。
export function buildR2Key(slug, relativePath) {
  return `modules/${slug}/${relativePath}`;
}

// 拼 URL 时按段编码；key 本身保持原始中文 / 特殊字符，不改名、不 ASCII 化。
export function encodeKeyPath(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

// 拒绝会串出条目根或覆盖索引的路径；不做引用重写，遇可疑直接拒上架。
export function isUnsafeRelativePath(relativePath) {
  const s = String(relativePath ?? '');
  if (!s || s.startsWith('/') || s.includes('\\') || s.includes('\0')) return true;
  const parts = s.split('/');
  return parts.some((p) => p === '' || p === '.' || p === '..');
}

// 单文件区与拖拽树同名、两单文件同名、树内自身重名 → 一律拒，不静默覆盖（原则 8）。
export function findDuplicateNames(consoleFile, mindmapFile, relativePaths = []) {
  const conflicts = [];
  if (consoleFile === mindmapFile) conflicts.push(`两单文件同名：${consoleFile}`);
  const seen = new Set();
  for (const rel of relativePaths) {
    if (seen.has(rel)) conflicts.push(`拖拽树内重名：${rel}`);
    seen.add(rel);
  }
  for (const name of [consoleFile, mindmapFile]) {
    if (seen.has(name)) conflicts.push(`单文件与拖拽树重名：${name}`);
  }
  return conflicts;
}

export function buildUploadPlan(slug, consoleFile, mindmapFile, relativePaths = []) {
  return [
    { relativePath: consoleFile, key: buildR2Key(slug, consoleFile) },
    { relativePath: mindmapFile, key: buildR2Key(slug, mindmapFile) },
    ...relativePaths.map((rel) => ({ relativePath: rel, key: buildR2Key(slug, rel) })),
  ];
}

// 单文件同名显式跳过（W1 #5 后续 / 包①b）。
// 背景：最自然的操作「①②区各选一个单文件 + 拖最外层总文件夹一次」时，总文件夹里
// 天然带着这两个单文件；一律「重名即拒」会让用户永远传不上去（档案 §0.6 第 210 行
// 登记的「设计冲突」）。这两个文件本来就是索引真值，树里那两份只是冗余副本。
// 收窄边界：只按「完全相同的 relativePath」匹配；不做裸名回退、不改 stripTopFolder。
// 树内自身重名 / 两单文件互相同名 / 路径不安全 / 缺依赖，仍由下游照旧拒绝。
// 返回 skipped 供上传端显式回执，绝不静默丢弃。
export function skipSingleFileDuplicates(consoleFile, mindmapFile, relativePaths = []) {
  const singles = new Set([consoleFile, mindmapFile].filter(Boolean));
  const kept = [];
  const skipped = [];
  for (const rel of relativePaths) {
    if (singles.has(rel)) skipped.push(rel);
    else kept.push(rel);
  }
  return { kept, skipped };
}
