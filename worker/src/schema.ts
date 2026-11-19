// 枚举与字段契约由 Worker 内 zod 强校验（§3.2）。
// 枚举取值本身来自 shared/contract.js —— 全站唯一出处，不在这里另写一份。
import { z } from 'zod';
import { SYSTEMS, KINDS, STATUSES } from '../../shared/contract.js';

const enumOf = (values: readonly string[], label: string) =>
  z.string().refine((v) => values.includes(v), {
    message: `${label} 必须是 ${values.join(' / ')}`,
  });

export const prepareSchema = z.object({
  title: z.string().min(1).max(200),
  slug: z
    .string()
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug 必须为英文小写短横线（如 frozen-malice）'),
  system: enumOf(SYSTEMS, 'system'),
  kind: enumOf(KINDS, 'kind'),
  status: enumOf(STATUSES, 'status'),
  summary: z.string().max(2000).optional().default(''),
  cover: z.string().max(500).optional().default(''),
  consoleFile: z.string().min(1).max(500),
  mindmapFile: z.string().min(1).max(500),
  // 上传端读出主控台 HTML 文本随请求送来，Worker 按实际引用逐项断言（不重写引用）
  consoleHtml: z.string().min(1).max(4_000_000),
  relativePaths: z.array(z.string().min(1).max(1000)).max(2000),
  // 成本闸门：key = relativePath（含两个单文件名），value = 字节数。
  // 上传端声明只是第一道，finalize 会用 R2 head().size 复核真实写入。
  sizes: z.record(z.string(), z.number().int().nonnegative()),
});

export type PrepareInput = z.infer<typeof prepareSchema>;
