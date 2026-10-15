import { resolveCountry, resolveSystem, isGeneral, seed } from '../shared/data';
import { listForecasts, writeReport, forecast } from '../shared/tools';
import { CATEGORY_KO } from '../shared/forecast';

export type Action = { type: 'set_mode'; system: string | null } | { type: 'toggle_map_mode'; flat?: boolean } | { type: 'focus_country'; country: string };
export interface LocalResult { text?: string; report?: string; actions: Action[] }

export const HELP = [
  '**명령**',
  '- `!모드 자주포` · `!모드 일반`',
  '- `!지도` 3D ↔ 2D',
  '- `!국가 폴란드`',
  '- `!예측 폴란드 자주포`',
  '- `!보고서 폴란드 자주포`',
  '- `!목록 호위함`',
  '- `!모델 제마`',
].join('\n');

/** !명령 처리. names: 지도 국가명(id→한글) */
export function runCommand(input: string, names: Record<string, string>): LocalResult | null {
  const m = /^[!！]\s*(\S+)\s*(.*)$/.exec(input.trim());
  if (!m) return null;
  const cmd = m[1].toLowerCase(), rest = m[2].trim();
  const words = rest.split(/\s+/).filter(Boolean);
  const pickSys = () => { for (let i = 0; i < words.length; i++) { const two = words.slice(i, i + 2).join(' '); const s = resolveSystem(two) ?? resolveSystem(words[i]); if (s) return s; } return null; };
  const pickCountry = () => { for (const w of [rest, ...words]) { const c = resolveCountry(w, names); if (c) return c; } return null; };
  switch (cmd) {
    case 'help': case '도움': case '도움말': case '명령': case 'h': return { text: HELP, actions: [] };
    case '모드': case 'mode': {
      if (!rest || isGeneral(rest)) return { text: '일반 모드', actions: [{ type: 'set_mode', system: null }] };
      const s = pickSys(); if (!s) return { text: '체계를 모르겠습니다.', actions: [] };
      return { text: `${seed.systems[s].ko} 모드`, actions: [{ type: 'set_mode', system: s }] };
    }
    case '지도': case 'map': return { text: '지도 전환', actions: [{ type: 'toggle_map_mode' }] };
    case '국가': case 'country': { const c = pickCountry(); if (!c) return { text: '국가를 모르겠습니다.', actions: [] }; return { text: `${names[c] ?? seed.countries[c]?.ko ?? c}`, actions: [{ type: 'focus_country', country: c }] }; }
    case '예측': case 'forecast': {
      const c = pickCountry(); const s = pickSys(); if (!c) return { text: '국가를 모르겠습니다.', actions: [] };
      const r = forecast({ country: c, system: s ?? undefined });
      if (!Array.isArray(r)) return { text: r.error, actions: [{ type: 'focus_country', country: c }] };
      const lines = r.map(f => `- **${f.system}** ${f.window ?? '—'} · ${f.imminence} · ${f.qty} · ${f.krw} · 신뢰도 ${f.confidence}`);
      const acts: Action[] = [{ type: 'focus_country', country: c }]; if (s) acts.unshift({ type: 'set_mode', system: s });
      return { text: `**${seed.countries[c]?.ko ?? c} 예측**\n${lines.join('\n')}`, actions: acts };
    }
    case '보고서': case 'report': {
      const c = pickCountry(); const s = pickSys(); if (!c) return { text: '국가를 모르겠습니다.', actions: [] };
      const r = writeReport({ country: c, system: s ?? undefined });
      if ('error' in r) return { text: r.error, actions: [] };
      const acts: Action[] = [{ type: 'focus_country', country: c }]; if (s) acts.unshift({ type: 'set_mode', system: s });
      return { report: r.markdown, actions: acts };
    }
    case '목록': case 'list': {
      const s = pickSys();
      const top = listForecasts({ system: s ?? undefined, limit: 8 });
      return { text: `**${s ? seed.systems[s].ko : '전체'} 임박 순**\n` + top.map((f, i) => `${i + 1}. ${f.country} ${s ? '' : f.system + ' '}${f.window ?? '—'} · ${f.imminence} · ${f.krw}`).join('\n'), actions: s ? [{ type: 'set_mode', system: s }] : [] };
    }
  }
  return { text: `모르는 명령: !${cmd}\n${HELP}`, actions: [] };
}

/** 키가 없을 때의 간단한 자연어 해석: 국가·체계·'보고서' */
export function naiveIntent(text: string, names: Record<string, string>): LocalResult | null {
  const c = resolveCountry(text, names) ?? Object.entries(seed.countries).find(([, v]) => text.includes(v.ko))?.[0] ?? null;
  const s = resolveSystem(text);
  if (c && /보고서|리포트|report/i.test(text)) return runCommand(`!보고서 ${c} ${s ?? ''}`, names);
  if (c && /예측|전망|언제|규모/.test(text)) return runCommand(`!예측 ${c} ${s ?? ''}`, names);
  return null;
}
export { CATEGORY_KO };
