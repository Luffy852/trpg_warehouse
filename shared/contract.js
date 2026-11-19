// 项目口径唯一出处：枚举 / slug / 元数据校验。
// Worker（强校验）、上传端（预检）、node:test（断言）共用这一份，不写第二份。
// 对应档案 §0.4「分类枚举」「分类判据」、§3.2「接口契约」。

export const SYSTEMS = ['dnd', 'coc', 'other'];
export const KINDS = ['campaign', 'module', 'encounter'];
export const STATUSES = ['draft', 'published'];

export const SYSTEM_LABELS = { dnd: 'DND', coc: 'COC', other: '其他规则' };
export const KIND_LABELS = { campaign: '战役', module: '模组', encounter: '遭遇' };
export const STATUS_LABELS = { draft: '草稿', published: '已发布' };

// slug 由英文小写短横线生成；纯中文标题会被过滤为空，上传端据此提示人工填写。
export function slugify(input) {
  return String(input ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateMeta(meta) {
  const errors = [];
  if (!meta || typeof meta !== 'object') return ['元数据缺失'];
  if (typeof meta.title !== 'string' || !meta.title.trim()) errors.push('title 必填');
  if (typeof meta.slug !== 'string' || !SLUG_RE.test(meta.slug)) {
    errors.push('slug 必须为英文小写短横线（如 frozen-malice）');
  }
  if (!SYSTEMS.includes(meta.system)) errors.push(`system 必须是 ${SYSTEMS.join(' / ')}`);
  if (!KINDS.includes(meta.kind)) errors.push(`kind 必须是 ${KINDS.join(' / ')}`);
  if (!STATUSES.includes(meta.status)) errors.push(`status 必须是 ${STATUSES.join(' / ')}`);
  if (meta.summary != null && typeof meta.summary !== 'string') errors.push('summary 必须是字符串');
  if (meta.cover != null && typeof meta.cover !== 'string') errors.push('cover 必须是字符串');
  return errors;
}
