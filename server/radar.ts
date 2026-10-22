import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config, safeError } from './config';
import { containedPath, AppError } from './store';
export class RadarReader {
  private sql?: ReturnType<typeof postgres>;
  constructor() {
    if (!/^[a-z][a-z0-9_]*$/.test(config.schema)) throw new Error('잘못된 Radar 스키마입니다.');
    if (config.databaseUrl) this.sql = postgres(config.databaseUrl, {
      max: 2, prepare: false, ssl: 'require', connect_timeout: 12, idle_timeout: 10,
      connection: { search_path: config.schema, application_name: 'H5S-readonly', default_transaction_read_only: true, statement_timeout: 15000 }, onnotice: () => {},
    });
  }
  // Every transaction is read-only at PostgreSQL level. No repository initialization,
  // DDL, migrations, file writes, or existing Radar MCP mutation tools are invoked.
  private async read<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    if (!this.sql) throw new AppError('procurement-radar DB 연결정보가 없습니다. .secrets.example을 참고해주세요.', 503);
    return await this.sql.begin('READ ONLY', fn) as T;
  }
  async status() {
    try {
      const counts = await this.read(async tx => {
        const result: Record<string, number> = {};
        for (const t of ['records', 'sources', 'conversations']) result[t] = Number((await tx.unsafe(`SELECT count(*) n FROM ${t}`))[0].n);
        const mode = await tx`SHOW transaction_read_only`;
        if (mode[0].transaction_read_only !== 'on') throw new Error('DB 읽기 전용 확인 실패');
        return result;
      });
      return { connected: true, configured: true, counts };
    } catch (e) { return { connected: false, configured: !!this.sql, error: safeError(e) }; }
  }
  async conversations(query = '') {
    return this.read(async tx => await tx`SELECT id,title,created_at,updated_at FROM conversations WHERE title ILIKE ${'%' + query + '%'} ORDER BY updated_at DESC LIMIT 60`);
  }
  async conversation(id: string) {
    return this.read(async tx => {
      const [conversation] = await tx`SELECT id,title,created_at,updated_at FROM conversations WHERE id=${id}`;
      if (!conversation) throw new AppError('연결할 대화를 찾을 수 없습니다.', 404);
      const messages = await tx`SELECT id,role,text,created_at FROM messages WHERE conversation_id=${id} ORDER BY row_order`;
      const artifacts = await tx`SELECT a.id,a.name,a.path,a.mime,a.hash,a.kind,w.bytes FROM artifacts a LEFT JOIN workspace_files w USING(path) WHERE a.conversation_id=${id} ORDER BY a.row_order`;
      return { conversation, messages, artifacts };
    });
  }
  async search(query: string, kind: 'records' | 'sources' | 'reports' = 'records', limit = 15) {
    limit = Math.max(1, Math.min(30, limit));
    return this.read(async tx => {
      if (kind === 'reports') return await tx`SELECT id,conversation_id,basis_date,substring(markdown,1,10000) markdown,created_at FROM reports WHERE markdown ILIKE ${'%' + query + '%'} ORDER BY created_at DESC LIMIT ${limit}`;
      const table = kind === 'sources' ? 'sources' : 'records';
      return await tx.unsafe(`SELECT id,data FROM ${table} WHERE data ILIKE $1 ORDER BY id LIMIT $2`, ['%' + query + '%', limit]);
    });
  }
  async file(conversationId: string, artifactId: string) {
    const entry: any = await this.read(async tx => (await tx`SELECT a.*, w.object_key,w.bytes,w.hash remote_hash FROM artifacts a LEFT JOIN workspace_files w USING(path) WHERE a.id=${artifactId} AND a.conversation_id=${conversationId}`)[0]);
    if (!entry) throw new AppError('선택한 대화의 첨부자료를 찾을 수 없습니다.', 404);
    const path = String(entry.path).replaceAll('\\', '/');
    let bytes: Buffer;
    if (path.startsWith('workspaces/')) {
      if (!path.startsWith(`workspaces/${conversationId}/`)) throw new AppError('선택한 대화 밖의 경로입니다.');
      const local = containedPath(config.radarStorage, path);
      if (existsSync(local)) bytes = readFileSync(containedPath(config.radarStorage, path, true));
      else if (entry.object_key && config.supabaseUrl && config.supabaseKey) {
        const client = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
        const result = await client.storage.from(config.bucket).download(entry.object_key);
        if (result.error || !result.data) throw new AppError('보존된 Radar 파일 다운로드에 실패했습니다.', 502);
        bytes = Buffer.from(await result.data.arrayBuffer());
      } else throw new AppError('로컬 파일과 원격 다운로드 설정이 없습니다.', 404);
    } else {
      // Legacy absolute paths must still resolve inside this conversation's workspace.
      const root = join(config.radarStorage, 'workspaces', conversationId);
      bytes = readFileSync(containedPath(root, path, true));
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== (entry.remote_hash || entry.hash)) throw new AppError('원본 파일의 해시가 일치하지 않습니다.', 409);
    return { bytes, name: entry.name, mime: entry.mime, hash };
  }
  async close() { await this.sql?.end({ timeout: 3 }); }
}
