/** 앱이 만든 그록 빌드 세션 기록·정리(파일 시스템 주입, 순수 로직) */

export type FsLike = Pick<typeof import('node:fs'), 'existsSync' | 'readdirSync' | 'rmSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync'>;
export type PathLike = Pick<typeof import('node:path'), 'join'>;

/** ~/.grok/sessions/<그룹>/<uuid> 를 모두 지운다. 그룹이 앱 전용(ownGroup)이고 비면 그룹도 지운다 */
export function removeGrokSessionDirs(root: string, sid: string, fs: FsLike, path: PathLike, ownGroup?: string): number {
  if (!/^[0-9a-f-]{36}$/i.test(sid) || !fs.existsSync(root)) return 0;
  let n = 0;
  for (const g of fs.readdirSync(root)) {
    const d = path.join(root, g, sid);
    if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); n++; }
  }
  if (ownGroup) {
    const gd = path.join(root, ownGroup);
    try { if (fs.existsSync(gd) && !fs.readdirSync(gd).some(x => /^[0-9a-f-]{36}$/i.test(x))) fs.rmSync(gd, { recursive: true, force: true }); } catch { /* 무시 */ }
  }
  return n;
}
export const grokGroupName = (cwd: string) => encodeURIComponent(cwd);

export function readRegistry(file: string, fs: FsLike): string[] {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j.filter(x => typeof x === 'string') : []; } catch { return []; }
}
export function writeRegistry(file: string, ids: string[], fs: FsLike) { fs.writeFileSync(file, JSON.stringify([...new Set(ids)])); }

/** 등록된(또는 앱 전용 그룹에 남은) 세션을 모두 지울 목록 */
export function leftoverSessions(registry: string[], root: string, ownGroup: string, fs: FsLike, path: PathLike): string[] {
  const ids = new Set(registry);
  const gd = path.join(root, ownGroup);
  try { if (fs.existsSync(gd)) for (const x of fs.readdirSync(gd)) if (/^[0-9a-f-]{36}$/i.test(x)) ids.add(x); } catch { /* 무시 */ }
  return [...ids].filter(x => /^[0-9a-f-]{36}$/i.test(x));
}
