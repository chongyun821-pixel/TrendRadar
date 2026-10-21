/**
 * Oryx 사진 확인 손실 목록(러시아·우크라이나) → consumption(kind='loss'). 인증키 불필요, 블로그 HTML 구조를 정규식으로 읽는다.
 * 손실 수는 사진·영상으로 확인된 최소값이다(실제 손실은 더 많다). 전문 매체 수준으로 보고 신뢰도 0.7.
 * 사용: npm run ingest:oryx -- [--dry-run] [--side RUS|UKR] [--file 저장한.html]
 */
import type { ConsumptionRow, SystemKey } from '../../shared/types';
import { isMain, load, readInput, runCli, text, type IngestOptions } from './common';
import { stripTags } from './html';

export const ORYX_PAGES = {
  RUS: { url: 'https://www.oryxspioenkop.com/2022/02/attack-on-europe-documenting-equipment.html', target: 'UKR' },
  UKR: { url: 'https://www.oryxspioenkop.com/2022/02/attack-on-europe-documenting-ukrainian.html', target: 'RUS' },
} as const;
export const ORYX_SOURCE = { id: 'oryx_ukraine', title: 'Oryx — Attack On Europe: Documenting Equipment Losses (Russia·Ukraine)', url: ORYX_PAGES.RUS.url, confidence: 0.7 };
export const ORYX_CONFLICT = 'russia-ukraine-2022';

/** Oryx 분류 → 앱 체계. 함정 분류는 모델명으로 호위함·잠수함만 고른다 */
export function oryxSystem(category: string, model: string): SystemKey | null {
  const c = category.toLowerCase();
  if (c.startsWith('self-propelled artillery')) return 'sph';
  if (c.startsWith('infantry fighting vehicles')) return 'ifv';
  if (c.startsWith('rocket and missile artillery')) return /\b(iskander|tochka|9k720|9p78|9k79)\b/i.test(model) ? null : 'mrl';
  if (c.startsWith('surface-to-air missile systems')) return 'sam';
  if (c.startsWith('naval ships')) return /frigate/i.test(model) ? 'frigate' : /submarine/i.test(model) ? 'ssk' : null;
  return null;
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function parseOryx(html: string, user: 'RUS' | 'UKR', period: string) {
  const rows: Partial<ConsumptionRow>[] = [];
  const parts = html.split(/<h3\b[^>]*>/i).slice(1);
  for (const part of parts) {
    const end = part.search(/<\/h3>/i); if (end < 0) continue;
    const category = stripTags(part.slice(0, end)).replace(/\s*\(.*$/, '').trim();
    for (const m of part.slice(end).matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi)) {
      const label = stripTags(m[1]);
      const hit = /^(\d+)\s+(.+?):?$/.exec(label); if (!hit) continue;
      const model = hit[2].trim(), system = oryxSystem(category, model);
      if (!system) continue;
      rows.push({ id: `oryx:${user}:${system}:${slug(model)}`, conflict: ORYX_CONFLICT, user_country: user, target_country: ORYX_PAGES[user].target, system, model, quantity: Number(hit[1]), period, kind: 'loss' });
    }
  }
  return rows;
}

export async function ingestOryx(opts: IngestOptions = {}) {
  const sides = (typeof opts.args?.side === 'string' ? [opts.args.side.toUpperCase()] : ['RUS', 'UKR']) as ('RUS' | 'UKR')[];
  if (opts.file && sides.length !== 1) throw new Error('--file을 쓸 때는 --side RUS 또는 --side UKR을 함께 주세요');
  const period = `2022-02~${(opts.now || new Date().toISOString()).slice(0, 7)}`;
  const rows: Partial<ConsumptionRow>[] = [];
  for (const side of sides) rows.push(...parseOryx(text(await readInput(opts, ORYX_PAGES[side].url)), side, period));
  if (!rows.length) throw new Error('Oryx 손실 항목을 찾지 못했습니다(페이지 구조 변경 확인 필요)');
  return load(opts, ORYX_SOURCE, { consumption: rows }, [`${sides.join('·')} 손실, 기간 ${period}, 사진 확인 최소값`]);
}

if (isMain(import.meta.url)) await runCli('oryx', ingestOryx);
