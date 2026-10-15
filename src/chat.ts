import { md, esc } from './md';
import { runCommand, naiveIntent, HELP, type Action } from './commands';
import { resolveCountry, resolveSystem, isGeneral, seed } from '../shared/data';
import type { SystemKey } from '../shared/types';

interface ChatOpts {
  names: Record<string, string>;
  getState(): { mode: SystemKey | null; flat: boolean; focus: string | null };
  actions: { set_mode(s: SystemKey | null): void; toggle_map_mode(flat?: boolean): void; focus_country(id: string): void };
  modeKo(): string | null;
}
type Msg = { role: 'user' | 'model'; text: string };

export function initChat(o: ChatOpts) {
  const root = document.querySelector('#chat') as HTMLElement;
  const list = root.querySelector('#msgs') as HTMLElement;
  const form = root.querySelector('form') as HTMLFormElement;
  const input = root.querySelector('#q') as HTMLInputElement;
  const sug = root.querySelector('#suggest') as HTMLElement;
  const history: Msg[] = [];
  let busy = false;

  const open = () => root.classList.add('open');
  const collapse = () => { root.classList.remove('open'); input.blur(); };
  input.addEventListener('focus', open);
  root.querySelector('#chatToggle')!.addEventListener('click', () => root.classList.toggle('open'));
  document.querySelector('#globe')!.addEventListener('pointerdown', () => { if (!input.value) collapse(); });

  function add(role: 'user' | 'bot' | 'report' | 'wait', html: string) {
    const d = document.createElement('div'); d.className = `m ${role}`; d.innerHTML = html; list.appendChild(d);
    list.scrollTop = role === "report" ? d.offsetTop - 8 : list.scrollHeight; return d;
  }
  function exec(acts: Action[] | undefined) {
    for (const a of acts ?? []) {
      if (a.type === 'set_mode') { const s = a.system && !isGeneral(a.system) ? resolveSystem(a.system) : null; o.actions.set_mode(s); }
      else if (a.type === 'toggle_map_mode') o.actions.toggle_map_mode(a.flat);
      else if (a.type === 'focus_country') { const c = resolveCountry(a.country, o.names); if (c) o.actions.focus_country(c); }
    }
  }

  async function send(text: string) {
    text = text.trim(); if (!text || busy) return;
    open(); add('user', esc(text)); input.value = '';
    const local = runCommand(text, o.names);
    if (local) {
      exec(local.actions);
      if (local.text) add('bot', md(local.text));
      if (local.report) add('report', md(local.report));
      return;
    }
    busy = true; root.classList.add('busy');
    const w = add('wait', '<span class="dots"><i></i><i></i><i></i></span>');
    try {
      const st = o.getState();
      const r = await fetch('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [...history.slice(-6), { role: 'user', text }], state: { mode: st.mode, flat: st.flat, focus: st.focus ? o.names[st.focus] ?? st.focus : null } }),
      });
      const j = await r.json().catch(() => ({}));
      w.remove();
      if (j.nokey) {
        const n = naiveIntent(text, o.names);
        if (n) { exec(n.actions); if (n.text) add('bot', md(n.text)); if (n.report) add('report', md(n.report)); }
        add('bot', md('AI 키 없음 · `!help`'));
        return;
      }
      if (!r.ok || j.error) { add('bot', esc(j.error || `오류 ${r.status}`)); return; }
      exec(j.actions);
      for (const rep of j.reports ?? []) add('report', md(rep));
      if (j.reply) add('bot', md(j.reply));
      history.push({ role: 'user', text }, { role: 'model', text: String(j.reply ?? '').slice(0, 600) });
    } catch {
      w.remove();
      const n = naiveIntent(text, o.names);
      if (n) { exec(n.actions); if (n.text) add('bot', md(n.text)); if (n.report) add('report', md(n.report)); }
      else add('bot', md('서버 연결 실패 · `!help`'));
    } finally { busy = false; root.classList.remove('busy'); }
  }
  form.addEventListener('submit', e => { e.preventDefault(); send(input.value); });

  function suggest(id: string | null) {
    if (!id) { sug.innerHTML = ''; sug.classList.remove('show'); return; }
    const name = o.names[id] ?? id;
    const mk = o.modeKo();
    const has = seed.records.some(r => r.country === id);
    if (!has) { sug.innerHTML = ''; sug.classList.remove('show'); return; }
    const label = `${name}${mk ? ' ' + mk : ''} 보고서`;
    sug.innerHTML = `<button type="button">${esc(label)}</button>`;
    sug.classList.add('show');
    (sug.firstElementChild as HTMLButtonElement).onclick = () => send(`!보고서 ${name}${mk ? ' ' + mk : ''}`);
  }
  return { send, suggest, collapse, open, HELP };
}
