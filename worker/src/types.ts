// 唯一 Worker 的绑定契约；与 wrangler.toml 一一对应。
export interface Env {
  /** Workers Assets 绑定：/upload 页面受 Access 校验后由 Worker 主动取静态壳 */
  ASSETS: { fetch(request: Request | string): Promise<Response> };
  /** R2 绑定：finalize 时 head() 追到真实写入，下载兜底时 get() */
  ASSETS_BUCKET: R2Bucket;
  /** D1 绑定：索引唯一真值 */
  DB: D1Database;

  R2_PUBLIC_BASE_URL: string;
  R2_BUCKET: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  UPLOAD_TOKEN_SECRET: string;
  PRESIGN_EXPIRES?: string;
  /** 成本闸门阈值（可选，缺省用 shared/cost.js 默认值）；在 GitHub 网页编辑 wrangler.toml 即可调 */
  MAX_SINGLE_FILE_MB?: string;
  MAX_ENTRY_MB?: string;
  MAX_FILES_PER_ENTRY?: string;
  BUCKET_CAP_GB?: string;
  /** 一键熔断：设 "0" 后所有写口立刻 503；缺省 "1"。纯点击改配置即可 */
  WRITES_ENABLED?: string;
}

export interface ModuleRow {
  slug: string;
  title: string;
  system: string;
  kind: string;
  summary: string;
  cover: string;
  status: string;
  console_file: string;
  mindmap_file: string;
  created_at: string;
  /** 该条目实际占用 R2 的字节数，由 finalize 用 head().size 累加；用于 8GB 容量锁 */
  total_bytes: number;
}
