// W2-c 第 1 步 · 模组管理台：排序 / 标签 / 按钮态的唯一口径出处。
// Worker（受保护全量列表）、上传端管理台、node:test / 冒烟共用这一份，不写第二份。
// 对应本窗口 R4 / R5 用户拍板：五列纵向列表、按体系 → slug A→Z、slug 只读、
// 状态沿用库里「已发布 / 草稿」、第 1 步只亮「上架」、下架 / 删除灰着不可点。
import { SYSTEMS, SYSTEM_LABELS, KIND_LABELS, STATUS_LABELS } from './contract.js';

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
 * 第 1 步按钮态：只亮「上架」，「下架 / 删除」灰着不可点（用户 R5-3）。
 * 「预览 / 条目页」是同一个按钮位、按状态二态（用户 R5 澄清）：
 * 草稿＝「预览」走受保护预览壳；已发布＝「条目页」走前台原条目页。
 */
export function adminRowActions(status) {
  const draft = status === 'draft';
  return {
    previewLabel: draft ? '预览' : '条目页',
    publishEnabled: draft,
    unpublishEnabled: false,
    removeEnabled: false,
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
