// W2-c · 模组管理台：排序 / 标签 / 按钮态 / 删除确认的唯一口径出处。
// Worker（受保护全量列表 + 状态写口 + 删除 / 校准）、上传端管理台、node:test / 冒烟
// 共用这一份，不写第二份。
// 对应本窗口 R4 / R5 / R6 / R7 用户拍板：五列纵向列表、按体系 → slug A→Z、slug 只读；
// 第 1 步亮上架、第 2 步亮下架、第 3 步亮删除；灰按钮不加额外注释（R5-3）。
import { SYSTEMS, SYSTEM_LABELS, KIND_LABELS, STATUS_LABELS } from './contract.js';
import { MODULE_KEY_PREFIX } from './paths.js';

/** 第三列「规则及体量」：DND-战役 / COC-模组 / 其他规则-遭遇 */
export function systemKindLabel(system, kind) {
  return `${SYSTEM_LABELS[system] ?? system}-${KIND_LABELS[kind] ?? kind}`;
}

/** 第四列状态：沿用库里的「已发布 / 草稿」，不另造显示文案（用户 R5-1） */
export function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

/**
 * 排序：优先规则体系（枚举序 dnd → coc → other，与前台大区一致），其次 slug A→Z。
 * 不按时间 / 热度，中文标题不参与排序（用户 R4-4）。不修改入参。
 */
export function sortAdminRows(rows) {
  const rank = new Map(SYSTEMS.map((s, i) => [s, i]));
  return [...rows].sort((a, b) => {
    const ra = rank.has(a?.system) ? rank.get(a.system) : SYSTEMS.length;
    const rb = rank.has(b?.system) ? rank.get(b.system) : SYSTEMS.length;
    if (ra !== rb) return ra - rb;
    const sa = String(a?.slug ?? '');
    const sb = String(b?.slug ?? '');
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return 0;
  });
}

/**
 * 按钮态（按状态翻转）：
 * 「预览页 / 条目页」是同一个按钮位、按状态二态（用户 R5 澄清 / R7-2 定稿）——
 *   草稿＝「预览页」走受保护预览壳；已发布＝「条目页」走前台原条目页。
 *   两个文案同为 3 字，翻转时按钮同宽、表格不跳（用户 R7-2）。
 * 上架只对草稿亮、下架只对已发布亮，二者互斥；删除两种状态都亮（R7 第 8 题）。
 */
export function adminRowActions(status) {
  return {
    previewLabel: status === 'draft' ? '预览页' : '条目页',
    publishEnabled: canPublish(status),
    unpublishEnabled: canUnpublish(status),
    removeEnabled: true,
  };
}

/** 预览按钮目标：草稿走 /upload/ 受保护预览壳；已发布走原前台条目页 */
export function previewTarget(slug, status) {
  const q = `?slug=${encodeURIComponent(slug)}`;
  return status === 'draft' ? `/upload/preview.html${q}` : `/module.html${q}`;
}

/** 上架写口允许的迁移：只接受 draft → published，其余一律拒（防重复点 / 防误操作） */
export function canPublish(status) {
  return status === 'draft';
}

/** 下架写口允许的迁移：只接受 published → draft，其余一律拒（可逆，文件不动） */
export function canUnpublish(status) {
  return status === 'published';
}

/**
 * 删除的「手打 slug 确认」唯一口径（用户 R7 第 1 题：打 slug，两种状态都要手打）。
 * Worker 侧也用它校验，绕过前端直接打接口同样挡得住；取消 / 空值 / 打错一律拒。
 * 只容忍首尾空格（trim），不做大小写归一、不做包含匹配 —— 防误删要严。
 */
export function matchesDeleteConfirm(slug, typed) {
  return (
    typeof slug === 'string' && slug.length > 0 &&
    typeof typed === 'string' && typed.trim() === slug
  );
}

/** 删除确认文案：已发布多提示一句「正在对外展示」，并入同一个确认框、不弹两次窗 */
export function deleteConfirmMessage(slug, status) {
  const intro = status === 'published'
    ? '这条正在对外展示，删除后访客立刻看不到。\n'
    : '';
  return `${intro}删除不可恢复，会连同仓库里的文件一起清掉。\n请手打一遍 slug「${slug}」确认：`;
}

/** 顶部校准模块的静态快照口径：未校准时给 null，页面显示「— / 尚未校准」 */
export function storageSnapshot(row) {
  if (!row || !Number.isSafeInteger(row.total_bytes) || row.total_bytes < 0) return null;
  return {
    totalBytes: row.total_bytes,
    calibratedAt: String(row.calibrated_at ?? ''),
  };
}

/**
 * 本项目在 R2 里的命名空间前缀：唯一出处在 shared/paths.js（与 buildR2Key 同源）。
 * 这里保留同名导出，让既有 import / 冒烟断言继续成立，不制造第二份常量（D-04）。
 * 用户 R10：这个 R2 桶可能与另一个项目共用 → 列举 / 删除 / 算规模一律只碰这个前缀。
 */
export { MODULE_KEY_PREFIX };

/**
 * 从 R2 key 提取所属 slug。key 格局的唯一出处是 shared/paths.js 的
 * buildR2Key = `<MODULE_KEY_PREFIX><slug>/<relativePath>`；不符合格局的对象一律取不到 slug。
 */
export function slugFromR2Key(key) {
  const k = String(key ?? '');
  if (!k.startsWith(MODULE_KEY_PREFIX)) return null;
  const rest = k.slice(MODULE_KEY_PREFIX.length);
  const slash = rest.indexOf('/');
  // 等价原正则 ^modules\/([^/]+)\/：slug 至少 1 字符，且后面必须还有一段路径
  if (slash <= 0) return null;
  return rest.slice(0, slash) || null;
}

/**
 * 校准时的「孤儿对象」判定（用户 R9 + R10 定稿）。
 * R9：R2 里没有任何 slug 索引、前端拉不到的垃圾要**真删掉**，不登记「孤儿值」回账本。
 * R10：桶可能与别的项目共用 → **只认 modules/ 前缀内的对象**；前缀外的东西
 *      （别的项目文件、桶根杂项）一律返回 false，绝不删、也不计入本项目规模。
 * 前缀内两类算垃圾：① 格局不合法（如 `modules/foo` 散对象，映射不到 slug）；
 *                ② slug 已不在 D1 索引里（半途放弃的上传 / 删除残留）。
 * 双保险：校准写口列举时本身也带 `modules/` 前缀，前缀外对象连列表都进不来。
 */
export function isOrphanR2Key(key, slugs) {
  const k = String(key ?? '');
  if (!k.startsWith(MODULE_KEY_PREFIX)) return false;
  const slug = slugFromR2Key(k);
  if (!slug) return true;
  return !(slugs instanceof Set ? slugs.has(slug) : slugs.includes(slug));
}
