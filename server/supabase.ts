import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

export interface SupabaseConfig {
  databaseUrl: string;
  url: string;
  secretKey: string;
  bucket: string;
  schema: string;
}

export function databaseClient(config: SupabaseConfig) {
  if (!/^[a-z][a-z0-9_]*$/.test(config.schema)) throw new Error('잘못된 PostgreSQL 스키마 이름');
  if (!/^postgres(?:ql)?:\/\//.test(config.databaseUrl)) throw new Error('DATABASE_URL에 PostgreSQL 연결 주소를 입력하세요');
  return postgres(config.databaseUrl, {
    max: 3, prepare: false, ssl: 'require', connect_timeout: 15, idle_timeout: 10,
    connection: { search_path: config.schema, application_name: 'TrendRadar' },
    onnotice: () => {},
  });
}

/** SQL은 앱 내부에서만 제공하며, 값의 ?는 PostgreSQL 매개변수로 전달한다. */
export function postgresQuery(sql: string): string {
  let index = 0;
  let result = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, token => token === '?' ? `$${++index}` : token);
  result = result.replace(/\browid\b/g, 'row_order');
  if (/^INSERT OR IGNORE /i.test(result)) result = result.replace(/^INSERT OR IGNORE /i, 'INSERT ') + ' ON CONFLICT DO NOTHING';
  return result.replace(/value=CAST\(value AS INTEGER\)\+1/g, 'value=(CAST(value AS BIGINT)+1)::text');
}

export class SupabaseFiles {
  private client;
  constructor(private config: SupabaseConfig) {
    this.client = createClient(config.url, config.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  async ensureBucket() {
    const found = await this.client.storage.getBucket(this.config.bucket);
    if (found.data) {
      if (found.data.public) throw new Error('TrendRadar 파일 버킷은 비공개여야 합니다');
      return;
    }
    if (!['404', '400'].includes(String((found.error as any)?.statusCode))) throw new Error('Supabase 파일 버킷 조회 실패');
    const created = await this.client.storage.createBucket(this.config.bucket, { public: false, fileSizeLimit: 50 * 1024 * 1024 });
    if (created.error) throw new Error('Supabase 비공개 파일 버킷 생성 실패');
  }
  async put(key: string, bytes: Uint8Array) {
    const result = await this.client.storage.from(this.config.bucket).upload(key, bytes, { contentType: 'application/octet-stream', upsert: false });
    if (result.error && !['409', 'Duplicate'].includes(String((result.error as any).statusCode)) && !/already exists/i.test(result.error.message)) throw new Error('Supabase 파일 업로드 실패');
  }
  async get(key: string): Promise<Buffer> {
    const result = await this.client.storage.from(this.config.bucket).download(key);
    if (result.error || !result.data) throw new Error('Supabase 파일 다운로드 실패');
    return Buffer.from(await result.data.arrayBuffer());
  }
}
