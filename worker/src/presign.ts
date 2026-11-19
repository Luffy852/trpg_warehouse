// 大包不经过 Worker 请求体：Worker 只签 URL，浏览器直传 R2 S3 端点。
// 不签 Content-Type（signQuery 只签 host；浏览器自动加的 Content-Type 不参与校验），
// 上传端不手动 setRequestHeader，避免 SignatureDoesNotMatch。
import { AwsClient } from 'aws4fetch';
import type { Env } from './types';

export async function presignPut(env: Env, key: string, expires: number): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/`);
  // 交给 WHATWG URL 做中文 / 特殊字符的 path 编码；R2 key 本身仍是原始字符串。
  url.pathname = `/${env.R2_BUCKET}/${key}`;
  url.searchParams.set('X-Amz-Expires', String(expires));
  const signed = await client.sign(new Request(url.toString(), { method: 'PUT' }), {
    aws: { signQuery: true },
  });
  return signed.url;
}
