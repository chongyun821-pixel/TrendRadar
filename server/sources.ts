import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { execution } from './execution';
import { hash } from './store';
import { resolveCountry, resolveSystem } from '../shared/data';
import type { ToolDef } from './agent';

const S = (description: string) => ({ type: 'string' as const, description });
export const SOURCE_DEFS: ToolDef[] = [
  { name: 'search_sources', description: '인증키 없이 GOV.UK 공개 검색과 보존 출처에서 자료 후보를 찾는다. 검색 결과는 원문 검증이 아니다. 다른 국가의 자료는 기본 웹 도구로 보완한다', properties: { query: S('검색어. 공개 검색은 영문 권장'), country: S('대상 국가'), system: S('대상 무기체계'), limit: { type: 'integer' } }, required: ['query'] },
  { name: 'collect_source', description: '인증키가 필요 없는 공개 HTML, 텍스트, JSON, XML 또는 PDF 원문을 읽고 원본과 추출문을 보존한다. 로그인과 접근 제한은 우회하지 않는다', properties: { url: S('공개 원문 주소'), title: S('출처 제목'), publishedAt: S('실제 확인한 발행일. 미확인은 생략') }, required: ['url'] },
  { name: 'read_source', description: '보존한 출처의 식별자 또는 수집 도구가 반환한 파일 경로로 원문을 다시 읽는다', properties: { sourceId: S('조달 데이터의 출처 식별자'), filePath: S('현재 대화의 수집 파일 경로'), offset: { type: 'integer' }, length: { type: 'integer' } } },
];
export function publicAddress(address: string) {
  if (isIP(address) === 6) return /^[23][0-9a-f]{0,3}:/i.test(address) && !address.toLowerCase().startsWith('2001:db8:');
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b)));
}
const USER_AGENT = 'TrendRadar/1.0';
const MAX_BYTES = 10 * 1024 * 1024;
async function download(url: URL, signal: AbortSignal): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; bytes: Buffer }> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['', '80', '443'].includes(url.port)) throw new Error('공개 HTTP 또는 HTTPS 주소만 지원합니다');
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('내부 네트워크 주소는 수집할 수 없습니다');
  const address = addresses.find(a => a.family === 4) || addresses[0];
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json,text/plain,application/pdf,application/xml' },
      family: address.family, lookup: (_host, _options, cb) => cb(null, address.address, address.family),
    }, response => {
      const chunks: Buffer[] = []; let count = 0;
      response.on('data', (chunk: Buffer) => { count += chunk.length; if (count > MAX_BYTES) response.destroy(new Error('원문 크기가 10MB를 초과했습니다')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}
export function robotsAllowed(text: string, path: string) {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let group = { agents: [] as string[], rules: [] as { allow: boolean; path: string }[] };
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.split('#')[0].trim().match(/^(user-agent|disallow|allow):\s*(.*)$/i);
    if (!match) continue;
    const [, key, value] = match;
    if (key.toLowerCase() === 'user-agent') {
      if (group.rules.length) { groups.push(group); group = { agents: [], rules: [] }; }
      group.agents.push(value.toLowerCase());
    } else if (value) group.rules.push({ allow: key.toLowerCase() === 'allow', path: value });
  }
  groups.push(group);
  const specific = groups.filter(g => g.agents.some(a => a !== '*' && 'trendradar'.includes(a)));
  const selected = specific.length ? specific : groups.filter(g => g.agents.includes('*'));
  const matches = selected.flatMap(g => g.rules).filter(rule => {
    const expr = rule.path.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\\\$$/, '$');
    return new RegExp(`^${expr}`).test(path);
  }).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return !matches.length || matches[0].allow;
}
export async function fetchPublic(raw: string, signal: AbortSignal) {
  let url = new URL(raw);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const robots = await download(new URL('/robots.txt', url), signal);
    if (robots.status === 200 && !robotsAllowed(robots.bytes.toString('utf8'), url.pathname + url.search)) throw new Error('robots.txt에서 수집을 허용하지 않습니다');
    if (![200, 404, 410].includes(robots.status)) throw new Error(`robots.txt 확인 실패 (${robots.status})`);
    const response = await download(url, signal);
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) { url = new URL(response.headers.location, url); continue; }
    if (response.status !== 200) throw new Error(`공개 원문 접근 실패 (${response.status})`);
    return { ...response, url: url.href, mime: String(response.headers['content-type'] || '').split(';')[0] };
  }
  throw new Error('원문 주소의 이동 횟수를 초과했습니다');
}
export const sourceNetwork = { fetch: fetchPublic };
const decode = (text: string) => text.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, value) => { const n = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }).replace(/&nbsp;/gi, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export const htmlText = (html: string) => decode(html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<\/(p|div|h[1-6]|li|tr|section|article)>|<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
export async function sourceTool(name: string, a: Record<string, any>): Promise<unknown> {
  const ctx = await execution(), repo = ctx.repo;
  if (name === 'read_source') {
    if (a.sourceId) { const { researchTool } = await import('./research'); return researchTool('source_read', a); }
    const path = z.string().regex(/^sources\//).parse(a.filePath);
    const artifact = await repo.one("SELECT * FROM artifacts WHERE conversation_id=? AND name=? AND status='ok'", ctx.conversationId, path);
    if (!artifact) throw new Error('수집한 원문이 없습니다');
    if (!['original', 'search', 'extracted'].includes(artifact.kind)) throw new Error('원본 파일 대신 수집 결과의 추출문 filePath를 지정하세요');
    const bytes = readFileSync(await repo.ensureFile(artifact.path));
    if (hash(bytes) !== artifact.hash) throw new Error('원문 해시 불일치');
    const text = bytes.toString('utf8'), offset = z.number().int().nonnegative().parse(a.offset ?? 0), length = z.number().int().positive().parse(a.length ?? Math.max(1, text.length));
    return { text: text.slice(offset, offset + length), total: text.length, nextOffset: offset + length < text.length ? offset + length : null, hash: artifact.hash, kind: artifact.kind };
  }
  if (name === 'search_sources') {
    const query = z.string().min(1).max(1000).parse(a.query), limit = z.number().int().min(1).max(50).parse(a.limit ?? 10);
    const data = await repo.data(), country = resolveCountry(a.country), system = resolveSystem(a.system);
    if ((a.country && !country) || (a.system && !system)) throw new Error('대상 국가와 무기체계를 확인하세요');
    const ids = new Set(data.records.filter(r => (!country || r.country === country) && (!system || r.system === system)).flatMap(r => r.src));
    const terms = query.toLowerCase().split(/\s+/);
    const saved = Object.entries(data.sources).filter(([id, s]) => ids.has(id) && terms.some(q => `${s.t} ${s.u}`.toLowerCase().includes(q))).map(([id, s]) => ({ sourceId: id, title: s.t, url: s.u, provider: 'saved', kind: 'candidate' }));
    try {
      const url = new URL('https://www.gov.uk/api/search.json'); url.searchParams.set('q', query); url.searchParams.set('count', String(limit));
      const response = await sourceNetwork.fetch(url.href, ctx.signal), body = JSON.parse(response.bytes.toString('utf8'));
      const candidates = body.results.map((r: any) => ({ title: r.title, url: new URL(r.link, 'https://www.gov.uk').href, excerpt: r.description || '', publishedAt: r.public_timestamp || null, provider: 'govuk', kind: 'search' }));
      const log = await repo.artifact(ctx.conversationId, `sources/search-${randomUUID()}.json`, JSON.stringify({ query, country, system, results: body }, null, 2), { runId: ctx.runId, kind: 'search', mime: 'application/json', url: response.url });
      return { status: candidates.length || saved.length ? 'ok' : 'no_results', coverage: 'GOV.UK 공개 자료와 기존 보존 출처. 15개국 전체 검색을 보장하지 않으며 기본 웹 도구로 보완한다.', requestedScope: { country, system }, candidates: [...saved, ...candidates], filePath: log.name, verified: false };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const log = await repo.artifact(ctx.conversationId, `sources/search-failure-${randomUUID()}.json`, JSON.stringify({ query, error: String(error) }), { runId: ctx.runId, kind: 'search', status: 'failed', error: String(error) });
      return { status: 'failed', error: String(error), candidates: saved, filePath: log.name, nextStep: '기본 웹 검색이나 연결된 MCP로 보완하고 save_source로 원문을 보존하세요' };
    }
  }
  const url = z.string().url().parse(a.url);
  try {
    const response = await sourceNetwork.fetch(url, ctx.signal);
    const raw = await repo.artifact(ctx.conversationId, `sources/${randomUUID()}.original`, response.bytes, { runId: ctx.runId, kind: 'raw-source', mime: response.mime || 'application/octet-stream', url: response.url });
    let text: string;
    if (response.mime === 'application/pdf' || response.bytes.subarray(0, 5).toString() === '%PDF-') {
      const { PDFParse } = await import('pdf-parse'); const parser = new PDFParse({ data: response.bytes });
      try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
    } else if (/^text\//.test(response.mime) || /json|xml/.test(response.mime)) {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes);
      text = response.mime === 'text/html' ? htmlText(source) : source;
    } else throw new Error('원본은 보존했지만 이 자료 형식의 텍스트 추출은 지원하지 않습니다');
    if (!text.trim()) throw new Error('읽을 수 있는 원문이 없습니다. 동적 화면이나 스캔 문서는 기본 도구로 확인하세요');
    const publishedAt = a.publishedAt ? z.union([z.string().date(), z.string().datetime({ offset: true })]).parse(a.publishedAt) : null;
    const extracted = await repo.artifact(ctx.conversationId, `sources/${randomUUID()}.txt`, text, { runId: ctx.runId, kind: 'original', mime: 'text/plain', url: response.url, publishedAt });
    const result = { suggestedSourceId: `source-${extracted.hash.slice(0, 16)}`, t: a.title || response.url, u: response.url, y: publishedAt ? Number(publishedAt.slice(0, 4)) : 0, publishedAt, collectedAt: extracted.collected_at, filePath: extracted.name, hash: extracted.hash, kind: 'original', originalPath: raw.name, originalHash: raw.hash, totalChars: text.length, nextStep: 'read_source로 원문을 읽고 확인한 인용문을 조사 결과에 연결하세요' };
    await repo.artifact(ctx.conversationId, `sources/${randomUUID()}.metadata.json`, JSON.stringify(result, null, 2), { runId: ctx.runId, kind: 'source-metadata', mime: 'application/json' });
    return result;
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    await repo.artifact(ctx.conversationId, `sources/failure-${randomUUID()}.txt`, String(error), { runId: ctx.runId, kind: 'failure', url, status: 'failed', error: String(error) });
    throw error;
  }
}
