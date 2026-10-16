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
export type ModelInfo = { id: string; name: string; available: boolean };

const MODEL_ALIAS: Record<string, string> = { 그록: 'grok', 그록빌드: 'grok', grok: 'grok', 코덱스: 'codex', codex: 'codex', gpt: 'codex', 제마: 'gemma', gemma: 'gemma', 젬마: 'gemma', 네모트론: 'nemotron', nemotron: 'nemotron' };
/** `!모델 <이름>` → 모델 id */
export function pickModel(name: string, models: ModelInfo[]): string | null {
  const k = name.replace(/\s+/g, '').toLowerCase();
  if (MODEL_ALIAS[k]) return MODEL_ALIAS[k];
  return models.find(m => m.name.replace(/\s+/g, '') === k || m.id === k)?.id ?? null;
}

export function initChat(o: ChatOpts) {
  const root = document.querySelector('#chat') as HTMLElement;
  const list = root.querySelector('#msgs') as HTMLElement;
  const form = root.querySelector('form') as HTMLFormElement;
  const input = root.querySelector('#q') as HTMLInputElement;
  const sug = root.querySelector('#suggest') as HTMLElement;
  const sel = root.querySelector('#model') as HTMLSelectElement;
  const history: Msg[] = [];
  let busy = false;
  let activeRequest: AbortController | null = null;
  let models: ModelInfo[] = [{ id: 'gemma', name: '젬마', available: true }];
  let model = 'gemma';
  const KEY = 'pr.model';
  function setModel(id: string) {
    if (!models.some(m => m.id === id && m.available)) return false;
    model = id; sel.value = id; try { localStorage.setItem(KEY, id); } catch { /* 무시 */ }
    return true;
  }
  function renderModels(def: string) {
    const av = models.filter(m => m.available);
    sel.innerHTML = av.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    sel.hidden = av.length < 2;
    let saved: string | null = null; try { saved = localStorage.getItem(KEY); } catch { /* 무시 */ }
    if (!(saved && setModel(saved)) && !setModel(def)) setModel(av[0]?.id ?? 'gemma');
  }
  sel.addEventListener('change', () => setModel(sel.value));
  renderModels('gemma');
  fetch('/api/models').then(r => r.json()).then(j => { if (Array.isArray(j?.models)) { models = j.models; renderModels(j.default || 'gemma'); } }).catch(() => {});

  const open = () => root.classList.add('open');
  const collapse = () => { root.classList.remove('open'); input.blur(); };
  function reset() {
    const request = activeRequest;
    activeRequest = null;
    request?.abort();
    history.length = 0;
    list.replaceChildren();
    input.value = '';
    sug.replaceChildren();
    sug.classList.remove('show');
    busy = false;
    root.classList.remove('busy');
    input.focus();
  }
  root.querySelector('#chatReset')!.addEventListener('click', reset);
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
    const mm = /^[!！]\s*(?:모델|model)\s*(.*)$/i.exec(text);
    if (mm) {
      const want = mm[1].trim();
      if (!want) { add('bot', esc(models.find(m => m.id === model)?.name ?? model)); return; }
      const id = pickModel(want, models);
      if (id && setModel(id)) add('bot', esc(models.find(m => m.id === id)!.name));
      else add('bot', esc(id ? '사용 불가' : models.filter(m => m.available).map(m => m.name).join(' · ')));
      return;
    }
    const local = runCommand(text, o.names);
    if (local) {
      exec(local.actions);
      if (local.text) add('bot', md(local.text));
      if (local.report) add('report', md(local.report));
      return;
    }
    busy = true; root.classList.add('busy');
    const request = new AbortController();
    activeRequest = request;
    const w = add('wait', '<span class="dots"><i></i><i></i><i></i></span>');
    try {
      const st = o.getState();
      const r = await fetch('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        signal: request.signal,
        body: JSON.stringify({ model, messages: [...history.slice(-6), { role: 'user', text }], state: { mode: st.mode, flat: st.flat, focus: st.focus ? o.names[st.focus] ?? st.focus : null } }),
      });
      const j = await r.json().catch(() => ({}));
      if (activeRequest !== request) return;
      w.remove();
      if (j.nokey) {
        const n = naiveIntent(text, o.names);
        if (n) { exec(n.actions); if (n.text) add('bot', md(n.text)); if (n.report) add('report', md(n.report)); }
        add('bot', md(`${String(j.reply || 'AI 키 없음')} · \`!help\``));
        return;
      }
      if (!r.ok || j.error) { const e = add('bot', esc(j.error || `오류 ${r.status}`)); if (j.model) e.title = j.model; return; }
      exec(j.actions);
      for (const rep of j.reports ?? []) add('report', md(rep));
      if (j.reply) { const b = add('bot', md(j.reply)); if (j.model) { b.title = j.model; b.dataset.model = j.model; } }
      history.push({ role: 'user', text }, { role: 'model', text: String(j.reply ?? '').slice(0, 600) });
    } catch {
      if (activeRequest !== request) return;
      w.remove();
      const n = naiveIntent(text, o.names);
      if (n) { exec(n.actions); if (n.text) add('bot', md(n.text)); if (n.report) add('report', md(n.report)); }
      else add('bot', md('서버 연결 실패 · `!help`'));
    } finally {
      if (activeRequest === request) {
        activeRequest = null;
        busy = false;
        root.classList.remove('busy');
      }
    }
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
  return { send, suggest, collapse, open, HELP, getModel: () => model };
}
