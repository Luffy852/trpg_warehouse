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
}
