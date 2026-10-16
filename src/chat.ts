import { md, esc } from './md';
import { HELP, type Action } from './commands';
import { resolveCountry, resolveSystem, isGeneral, seed } from '../shared/data';
import type { SystemKey } from '../shared/types';

interface ChatOpts {
  names: Record<string, string>;
  getState(): { mode: SystemKey | null; flat: boolean; focus: string | null };
  actions: { set_mode(s: SystemKey | null): void; toggle_map_mode(flat?: boolean): void; focus_country(id: string): void };
  modeKo(): string | null;
  refreshData(): Promise<void>;
}
export type ModelInfo = { id: string; name: string; available: boolean };
const MODEL_ALIAS: Record<string, string> = { 그록: 'grok', 그록빌드: 'grok', grok: 'grok', 코덱스: 'codex', codex: 'codex', gpt: 'codex', 제마: 'gemma', gemma: 'gemma', 젬마: 'gemma', 네모트론: 'nemotron', nemotron: 'nemotron' };
export function pickModel(name: string, models: ModelInfo[]): string | null {
  const key = name.replace(/\s+/g, '').toLowerCase();
  return MODEL_ALIAS[key] || models.find(m => m.name.replace(/\s+/g, '').toLowerCase() === key || m.id === key)?.id || null;
}
type Download = { id: string; name: string; url: string };
type Message = { role: string; text: string; reports?: string[]; files?: Download[]; model?: string; error?: string };
type Conversation = { id: string; title: string; messages: Message[]; files: { id: string; name: string; kind: string; error?: string }[]; runs: { id: string; status: string; error?: string }[] };
async function api(path: string, options?: RequestInit): Promise<any> {
  const r = await fetch(`/api${path}`, options);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `요청 실패 ${r.status}`);
  return data;
}
const post = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

export function initChat(o: ChatOpts) {
  const root = document.querySelector('#chat') as HTMLElement;
  const get = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  const list = get<HTMLElement>('#msgs'), input = get<HTMLTextAreaElement>('#q');
  const sel = get<HTMLSelectElement>('#model'), form = get<HTMLFormElement>('form');
  const status = get<HTMLElement>('#chatStatus'), historyPanel = get<HTMLElement>('#conversationList');
  const historyToggle = get<HTMLButtonElement>('#historyToggle'), fileInput = get<HTMLInputElement>('#fileInput');
  const stop = get<HTMLButtonElement>('#stopButton'), sendButton = get<HTMLButtonElement>('.send');
  const historyMenu = get<HTMLElement>('#historyMenu'), workspace = get<HTMLElement>('#workspace');
  const attachButton = get<HTMLButtonElement>('#attachButton'), addFiles = get<HTMLButtonElement>('#addFiles');
  const uploadStatus = get<HTMLElement>('#uploadStatus');
  const uploadedNames: string[] = [];
  let uploadTask: Promise<void> | null = null;
  let conversationId: string | null = null, activeRun: string | null = null, view = 0, sending = false;
  let models: ModelInfo[] = [{ id: 'gemma', name: '젬마', available: true }], model = 'gemma';
  const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* 저장 제한 */ } };
  const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
  function setModel(id: string) {
    if (!models.some(m => m.id === id && m.available)) return false;
    model = id; sel.value = id; save('pr.model', id); return true;
  }
  sel.addEventListener('change', () => setModel(sel.value));
  api('/models').then(j => {
    models = j.models; sel.innerHTML = models.filter(m => m.available).map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    sel.hidden = false;
    if (!setModel(read('pr.model') || '')) setModel(j.default);
  }).catch(e => { status.textContent = e.message; });
  const open = () => root.classList.add('open');
  const collapse = () => { root.classList.remove('open'); closeMenus(); input.blur(); };
  function closeMenus() {
    historyMenu.hidden = true; workspace.hidden = true;
    historyToggle.setAttribute('aria-expanded', 'false'); attachButton.setAttribute('aria-expanded', 'false');
  }
  function toggleMenu(menu: HTMLElement, button: HTMLElement) {
    const show = menu.hidden; closeMenus(); menu.hidden = !show; button.setAttribute('aria-expanded', String(show));
  }
  root.querySelectorAll<HTMLButtonElement>('.menu-close').forEach(button => button.onclick = closeMenus);
  document.addEventListener('pointerdown', e => { if (!get('.composer').contains(e.target as Node)) closeMenus(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && (!historyMenu.hidden || !workspace.hidden)) { closeMenus(); input.focus(); }
  });
  // 상태를 바꿀 때 마지막 메시지를 보던 사용자는 새 진행 상태도 계속 볼 수 있다.
  new MutationObserver(() => { if (status.textContent) open(); }).observe(status, { childList: true });
  function resizeInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(150, Math.max(34, input.scrollHeight))}px`;
  }
  input.addEventListener('input', resizeInput);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('focus', open);
  get('#chatToggle').addEventListener('click', () => root.classList.toggle('open'));
  document.querySelector('#globe')!.addEventListener('pointerdown', () => { if (!input.value && !activeRun) collapse(); });

  function add(role: string, html: string, modelName?: string) {
    const div = document.createElement('div'); div.className = `m ${role}`; div.innerHTML = html;
    if (modelName) div.title = modelName;
    list.appendChild(div); list.scrollTop = list.scrollHeight;
  }
  function renderMessage(message: Message) {
    if (message.role === 'user') add('user', md(message.text));
    else {
      for (const report of message.reports || []) add('report', md(report));
      if (message.text) add('bot', md(message.text), message.model);
      if (message.files?.length) {
        const box = document.createElement('div'); box.className = 'm downloads';
        for (const file of message.files) {
          if (!/^\/api\/conversations\/[0-9a-f-]+\/files\/[0-9a-f-]+$/i.test(file.url)) continue;
          const a = document.createElement('a'); a.href = file.url; a.download = ''; a.textContent = `↓ ${file.name.split('/').at(-1)}`; box.appendChild(a);
        }
        if (box.childNodes.length) { list.appendChild(box); list.scrollTop = list.scrollHeight; }
      }
    }
  }
  function exec(actions: Action[] = []) {
    for (const a of actions) {
      if (a.type === 'set_mode') o.actions.set_mode(a.system && !isGeneral(a.system) ? resolveSystem(a.system) : null);
      else if (a.type === 'toggle_map_mode') o.actions.toggle_map_mode(a.flat);
      else if (a.type === 'focus_country') { const country = resolveCountry(a.country, o.names); if (country) o.actions.focus_country(country); }
    }
  }
  function busy(on: boolean) {
    sending = on; root.classList.toggle('busy', on); stop.hidden = !on; sendButton.hidden = on;
    addFiles.disabled = on || !!uploadTask;
  }
  function renderFiles(c: Conversation) {
    const box = get('#workspaceFiles'); box.replaceChildren();
    const visible = c.files.filter(f => f.kind !== 'tool-log' && f.kind !== 'extracted');
    const count = get('#fileCount'); count.textContent = String(visible.length); count.hidden = !visible.length;
    if (!visible.length) box.textContent = '추가한 자료가 없습니다.';
    for (const f of visible) {
      const a = document.createElement('a'); a.href = `/api/conversations/${c.id}/files/${f.id}`;
      const name = f.name.split('/').at(-1)!.replace(/^[0-9a-f]{8}-[0-9a-f-]{27}-/i, '');
      const label = f.kind === 'report' && /^[0-9a-f-]{36}\.md$/i.test(name) ? '국가 보고서.md' : name;
      a.textContent = `${f.kind === 'document' ? '↓ ' : ''}${label}${f.error ? ' · 추출 오류' : ''}`;
      a.title = f.error || f.name; a.download = ''; a.classList.toggle('word-file', f.kind === 'document'); box.appendChild(a);
    }
  }
  attachButton.onclick = () => toggleMenu(workspace, attachButton);
  addFiles.onclick = () => fileInput.click();
  async function upload(files: File[]) {
    if (!files.length) return;
    if (sending || uploadTask) { status.textContent = '현재 작업이 끝나면 파일을 추가할 수 있습니다.'; return; }
    closeMenus(); workspace.hidden = false; attachButton.setAttribute('aria-expanded', 'true');
    const token = view; addFiles.disabled = true; uploadStatus.textContent = `${files.length}개 파일 업로드 중…`;
    const task = (async () => {
      try {
        const id = await ensureConversation(token);
        if (token !== view) return;
        const formData = new FormData(); for (const file of files) formData.append('files', file);
        const result = await api(`/conversations/${id}/files`, { method: 'POST', body: formData });
        if (token !== view) return;
        uploadedNames.push(...result.files.map((file: any, index: number) => `${files[index].name}${file.message ? ` (${file.message})` : ''}`));
        const notices = result.files.flatMap((file: any, index: number) => ['failed', 'unsupported'].includes(file.extraction) ? [`${files[index].name}: ${file.message}`] : []);
        uploadStatus.textContent = [`${files.length}개 파일 추가됨`, ...notices].join('\n');
        const conversation = await api(`/conversations/${id}`);
        if (token !== view) return;
        renderFiles(conversation); await refreshHistory();
      } catch (e) { if (token === view) uploadStatus.textContent = `업로드 실패 · ${e instanceof Error ? e.message : e}`; }
    })();
    uploadTask = task;
    try { await task; } finally { uploadTask = null; addFiles.disabled = sending; }
  }
  fileInput.onchange = () => { const files = Array.from(fileInput.files || []); fileInput.value = ''; void upload(files); };
  const overlay = get('#dropOverlay'); let dragDepth = 0;
  const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
  document.addEventListener('dragenter', e => {
    if (!isFileDrag(e)) return; e.preventDefault(); dragDepth++; overlay.hidden = false;
    overlay.querySelector('strong')!.textContent = sending || uploadTask ? '현재 작업이 끝난 뒤 파일을 추가하세요' : '파일을 놓아 대화에 추가';
  });
  document.addEventListener('dragover', e => { if (isFileDrag(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = sending || uploadTask ? 'none' : 'copy'; } });
  document.addEventListener('dragleave', e => { if (isFileDrag(e) && --dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
  document.addEventListener('drop', e => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth = 0; overlay.hidden = true; void upload(Array.from(e.dataTransfer?.files || [])); });
  window.addEventListener('blur', () => { dragDepth = 0; overlay.hidden = true; });
  async function refreshHistory() {
    const rows: { id: string; title: string }[] = await api('/conversations');
    historyPanel.replaceChildren();
    if (!rows.length) historyPanel.textContent = '저장된 대화가 없습니다.';
    for (const row of rows) {
      const line = document.createElement('div'); line.className = 'conversation-row';
      const select = document.createElement('button'); select.type = 'button'; select.textContent = row.title; select.classList.toggle('selected', row.id === conversationId);
      select.onclick = () => { void selectConversation(row.id).catch(showError); closeMenus(); };
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '삭제'; remove.setAttribute('aria-label', `${row.title} 대화 삭제`);
      remove.onclick = async () => {
        remove.disabled = true;
        try {
          await api(`/conversations/${row.id}`, { method: 'DELETE' });
          if (row.id === conversationId) newConversation();
          await refreshHistory();
        } catch (e) { showError(e); remove.disabled = false; }
      };
      line.append(select, remove); historyPanel.appendChild(line);
    }
    return rows;
  }
  function showError(e: unknown) { status.textContent = String(e instanceof Error ? e.message : e); }
  historyToggle.onclick = async () => {
    toggleMenu(historyMenu, historyToggle);
    if (!historyMenu.hidden) await refreshHistory().catch(showError);
  };
  function newConversation() {
    view++; conversationId = null; activeRun = null; busy(false); save('pr.conversation', '');
    list.replaceChildren(); uploadedNames.length = 0; input.value = ''; resizeInput(); status.textContent = ''; uploadStatus.textContent = '';
    get('#conversationTitle').textContent = '새 대화'; get('#workspaceFiles').textContent = '추가한 자료가 없습니다.'; get('#fileCount').hidden = true; closeMenus();
    open(); input.focus();
  }
  get('#chatReset').onclick = newConversation;
  function renderConversation(c: Conversation) {
    list.replaceChildren(); c.messages.forEach(renderMessage); get('#conversationTitle').textContent = c.title;
    renderFiles(c);
    const report = Array.from(list.querySelectorAll<HTMLElement>('.m.report')).at(-1);
    if (report && c.messages.at(-1)?.reports?.length) list.scrollTop = report.offsetTop - list.offsetTop;
  }
  async function selectConversation(id: string) {
    const token = ++view;
    const c: Conversation = await api(`/conversations/${id}`);
    if (view !== token) return;
    conversationId = id; save('pr.conversation', id); activeRun = null; busy(false); uploadedNames.length = 0; uploadStatus.textContent = '';
    renderConversation(c); open();
    const run = c.runs.find(r => ['running','stopping'].includes(r.status));
    if (run) { activeRun = run.id; busy(true); void poll(run.id, token); }
    else status.textContent = c.runs[0]?.error || '';
  }
  async function ensureConversation(token: number) {
    if (conversationId) return conversationId;
    const c = await api('/conversations', post());
    if (token === view) { conversationId = c.id; save('pr.conversation', c.id); }
    return c.id as string;
  }
  async function poll(runId: string, token: number) {
    let after = 0;
    try {
      while (token === view) {
        const run = await api(`/runs/${runId}?after=${after}`);
        if (token !== view) return;
        for (const event of run.events) {
          after = event.id;
          if (event.name === 'tool.start' || event.name === 'tool.call') status.textContent = `조사 중 · ${event.data.name}`;
          if (event.name === 'tool.error') status.textContent = `도구 실패 · ${event.data.name}: ${event.data.error}`;
          if (event.name === 'cli.tool') status.textContent = `조사 중 · ${event.data.toolName || event.data.item?.tool || event.data.item?.type || event.data.type}`;
          if (event.name === 'model.request') status.textContent = `응답 생성 중 · ${event.data.model}`;
          if (event.name === 'model.fallback') status.textContent = `모델 전환 · ${event.data.from} → ${event.data.to}`;
        }
        if (!['running','stopping'].includes(run.status)) {
          activeRun = null; busy(false);
          const c = await api(`/conversations/${conversationId}`);
          if (token !== view) return;
          renderConversation(c); exec(run.result?.actions);
          status.textContent = run.error || (run.status === 'completed' ? '완료' : run.status);
          await o.refreshData(); await refreshHistory(); return;
        }
        if (!after) status.textContent = run.status === 'stopping' ? '중지 중…' : '조사·응답 생성 중…';
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    } catch (e) {
      if (token === view) { showError(e); status.textContent += ' · 대화 목록에서 다시 선택해 진행 상황을 복원하세요.'; busy(false); }
    }
  }
  stop.onclick = async () => {
    if (!activeRun) return;
    stop.disabled = true; status.textContent = '중지 중…';
    try { await api(`/runs/${activeRun}/stop`, post()); } catch (e) { showError(e); } finally { stop.disabled = false; }
  };
  async function send(text: string) {
    if (uploadTask) await uploadTask;
    if (sending || (!text.trim() && !uploadedNames.length)) return;
    const modelCommand = /^[!！]\s*(?:모델|model)\s*(.*)$/i.exec(text.trim());
    if (modelCommand) {
      const target = pickModel(modelCommand[1], models);
      if (!target || !setModel(target)) { status.textContent = '모델 이름 또는 사용 가능 여부를 확인하세요'; return; }
    }
    const token = ++view;
    open(); closeMenus(); busy(true); status.textContent = '요청 준비 중…';
    try {
      const id = await ensureConversation(token);
      if (token !== view) return;
      if (uploadedNames.length) { text += `\n\n첨부: ${uploadedNames.join(', ')}`; uploadedNames.length = 0; }
      input.value = ''; resizeInput(); add('user', md(text));
      const st = o.getState();
      const run = await api('/chat', post({ conversationId: id, model, messages: [{ role: 'user', text }], state: { ...st, focus: st.focus ? o.names[st.focus] || st.focus : null } }));
      if (token !== view) return;
      activeRun = run.runId; await refreshHistory(); void poll(run.runId, token);
    } catch (e) { if (token === view) { showError(e); busy(false); } }
  }
  form.onsubmit = e => { e.preventDefault(); void send(input.value); };
  get('#workspaceFiles').textContent = '추가한 자료가 없습니다.';
  void refreshHistory().then(rows => {
    const id = read('pr.conversation');
    if (view === 0 && id && rows.some(r => r.id === id)) return selectConversation(id);
  }).catch(showError);
  function suggest(id: string | null) {
    const box = get('#suggest'); box.replaceChildren(); box.classList.remove('show');
    if (!id || !seed.records.some(r => r.country === id)) return;
    const label = `${o.names[id] || id}${o.modeKo() ? ` ${o.modeKo()}` : ''} 보고서`;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.onclick = () => { void send(`!보고서 ${o.names[id] || id} ${o.modeKo() || ''}`); };
    box.appendChild(button); box.classList.add('show');
  }
  return { send, suggest, collapse, open, HELP, getModel: () => model };
}
