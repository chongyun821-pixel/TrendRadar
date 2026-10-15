import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** .dev.vars (KEY=VALUE) 읽기. 없으면 빈 객체 */
export function loadDevVars(file = resolve(process.cwd(), '.dev.vars')): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#') || !l.includes('=')) continue;
    let [k, ...rest] = l.split('=');
    let v = rest.join('=').trim();
    k = k.replace(/^export\s+/, '').trim();
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
    if (v) out[k] = v;
  }
  return out;
}
