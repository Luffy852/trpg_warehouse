// W2-b · slug 重名显式更新开关：唯一口径出处。
// Worker（权威判定）、上传端（前端预检 + 行为断言）、node:test / 冒烟共用这一份，不写第二份。
// 对应档案 §0.4「slug 重名显式更新开关」、§5.2 W2-b，以及本窗口 D-01。
//
// 口径（用户 v5 拍板 + v6 窗口 R1–R4 确认）：
//   · 未勾选「模组更新」且 slug 已存在 → 拒绝，不允许静默覆盖（含 draft）。
//   · 勾选且 slug 已存在 → 覆盖更新（旧内容不保留、不二次确认；draft 同样直接覆盖）。
//   · 勾选但 slug 不存在 → 正常新建（勾选项只开「同名覆盖」这一个口子）。
//   · 覆盖时所有元数据字段都允许改，只有 slug 是唯一抓手；slug 本身不允许改。

/**
 * 判定本次上架走哪条路。exists 必须来自权威存储（Worker 查 D1，含 draft）；
 * 前端预检只能看到已发布条目，故前端传入的 exists 只是「提前挡下」，不是最终结论。
 * isUpdate 非严格 true 一律按「未勾选」处理（旧请求 / 旧令牌 / 脏值不会误开覆盖口子）。
 * @param {{ exists: boolean, isUpdate: boolean }} input
 * @returns {{ allowed: boolean, mode: 'created'|'updated'|null, code: string|null }}
 */
export function decideUploadMode({ exists, isUpdate }) {
  if (exists && isUpdate !== true) {
    return { allowed: false, mode: null, code: 'SLUG_EXISTS' };
  }
  return { allowed: true, mode: exists ? 'updated' : 'created', code: null };
}

/**
 * 行为断言：这次上架后浏览端卡片数「应该」变化多少。
 * created 一律按新状态算；updated 时若 status 发生 draft ↔ published 变化，
 * 卡片数本来就会 ±1，不能用「不变」一刀切（用户 R4 / Q3 口径）。
 * @param {{ mode: 'created'|'updated', previousStatus: string|null, nextStatus: string }} input
 * @returns {number}
 */
export function expectedCardDelta({ mode, previousStatus, nextStatus }) {
  const after = nextStatus === 'published' ? 1 : 0;
  if (mode === 'created') return after;
  const before = previousStatus === 'published' ? 1 : 0;
  return after - before;
}

// 浏览端 /api/modules 返回的字段 ↔ 本次提交的元数据字段（camelCase）。
// 只比「内容」字段：slug 是抓手不参与比对，createdAt / baseUrl 是派生值也不比对。
const CONTENT_FIELDS = [
  ['title', 'title'],
  ['system', 'system'],
  ['kind', 'kind'],
  ['status', 'status'],
  ['summary', 'summary'],
  ['cover', 'cover'],
  ['consoleFile', 'consoleFile'],
  ['mindmapFile', 'mindmapFile'],
];

/**
 * 更新模式下「内容已更新」的可判定实现：逐字段比对浏览端列表里的该条目与本次提交值。
 * draft→draft 的更新在列表里不可见（row 为 null），此时由 Worker 的 D1 写后读回校验兜住。
 * @param {{ row: object|null, submitted: object }} input
 * @returns {{ ok: boolean, visible: boolean, mismatches: string[] }}
 */
export function verifyUpdatedContent({ row, submitted }) {
  if (!row) return { ok: true, visible: false, mismatches: [] };
  const mismatches = [];
  for (const [rowKey, metaKey] of CONTENT_FIELDS) {
    if (row[rowKey] !== submitted[metaKey]) {
      mismatches.push(
        `${rowKey}: 期望 ${JSON.stringify(submitted[metaKey])}，实际 ${JSON.stringify(row[rowKey])}`,
      );
    }
  }
  return { ok: mismatches.length === 0, visible: true, mismatches };
}
