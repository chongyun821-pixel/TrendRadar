import { md, esc } from './md';
import { HELP, type Action } from './commands';
import { resolveCountry, resolveSystem, isGeneral, seed } from '../shared/data';
import type { SystemKey } from '../shared/types';
import type { AppContext, ReportRef } from '../shared/app-context';
import { createChatStatus, toolActivity } from './chat-status';

interface ChatOpts {
  names: Record<string, string>;
  getState(): { mode: SystemKey | null; flat: boolean; focus: string | null };
  dataVersion(): number;
  actions: { set_mode(s: SystemKey | null): void; toggle_map_mode(flat?: boolean): void; focus_country(id: string | null): void };
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
type Message = { role: string; text: string; reports?: string[]; reportRefs?: (ReportRef | null)[]; created_at?: string; files?: Download[]; model?: string; error?: string };
type ReportEntry = ReportRef & { markdown: string; createdAt: string };
type QueuedMessage = { id: string; text: string };
type DeliveryTarget = { id: string | null; creation?: Promise<string>; pending: number; task: Promise<void>; outbox: QueuedMessage[] };
const newTarget = (id: string | null = null): DeliveryTarget => ({ id, pending: 0, task: Promise.resolve(), outbox: [] });
type Conversation = { id: string; title: string; messages: Message[]; queued?: QueuedMessage[]; reportEntries?: ReportEntry[]; files: { id: string; name: string; kind: string; error?: string }[]; runs: { id: string; status: string; error?: string; started_at?: string; ended_at?: string }[] };
const latestRun = (c: Conversation) => [...c.runs].sort((a, b) => (b.ended_at || b.started_at || '').localeCompare(a.ended_at || a.started_at || ''))[0];
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
  const progress = createChatStatus(status);
  const historyToggle = get<HTMLButtonElement>('#historyToggle'), fileInput = get<HTMLInputElement>('#fileInput');
  const stop = get<HTMLButtonElement>('#stopButton'), sendButton = get<HTMLButtonElement>('.send');
  const historyMenu = get<HTMLElement>('#historyMenu'), workspace = get<HTMLElement>('#workspace');
  const attachButton = get<HTMLButtonElement>('#attachButton'), addFiles = get<HTMLButtonElement>('#addFiles');
  const uploadStatus = get<HTMLElement>('#uploadStatus');
  const uploadedNames: string[] = [];
  let uploadTask: Promise<void> | null = null;
  let conversationId: string | null = null, activeRun: string | null = null, view = 0, sending = false;
  let deliveryTarget = newTarget(), queueSignature = '';
  let queuedMessages: QueuedMessage[] = [];
  let models: ModelInfo[] = [{ id: 'gemma', name: '젬마', available: true }], model = 'gemma';
  const screenId = crypto.randomUUID();
  let contextVersion = 0, contextSignature = '', activeView: 'map' | 'report' = 'map', currentReport: ReportRef | null = null;
  let reportEntries: ReportEntry[] = [];
  function appSnapshot(): AppContext {
    const map = o.getState();
    const state = { screenId, conversationId, model, activeView, ...map, filters: { system: map.mode }, report: currentReport, dataVersion: o.dataVersion() };
    const signature = JSON.stringify(state);
    if (signature !== contextSignature) { contextSignature = signature; contextVersion++; }
    return { ...state, version: contextVersion };
  }
  let lastSyncedVersion = -1, lastSyncedAt = 0;
  async function syncContext() {
    const state = appSnapshot();
    if (state.version !== lastSyncedVersion || Date.now() - lastSyncedAt > 10_000) {
      await api('/app-context', post(state)); lastSyncedVersion = state.version; lastSyncedAt = Date.now();
    }
    return state;
  }
  addEventListener('radar:map-state', () => { activeView = 'map'; });
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
  }).catch(e => { progress.set(e.message); });
  const open = () => root.classList.add('open');
  const collapse = () => { root.classList.remove('open'); closeMenus(); input.blur(); activeView = 'map'; };
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
  input.addEventListener('input', updateSendButton);
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
    return div;
  }
  function renderMessage(message: Message) {
    if (message.role === 'user') add('user', md(message.text));
    else {
      for (const [index, report] of (message.reports || []).entries()) {
        const div = add('report', md(report));
        const ref = message.reportRefs?.[index] || reportEntries.filter(r => r.markdown === report && (!message.created_at || r.createdAt <= message.created_at)).at(-1);
        if (ref) div.dataset.reportId = ref.id;
      }
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
    sending = on; root.classList.toggle('busy', on); stop.hidden = !on; updateSendButton();
    addFiles.disabled = on || !!uploadTask;
  }
  function updateSendButton() { sendButton.hidden = sending && !input.value.trim(); }
  function renderQueued(messages: QueuedMessage[] = queuedMessages) {
    queuedMessages = messages;
    const signature = JSON.stringify([messages, deliveryTarget.outbox]);
    if (queueSignature === signature) return;
    queueSignature = signature;
    const atBottom = list.scrollHeight - list.clientHeight - list.scrollTop < 40;
    list.querySelectorAll('.m.queued').forEach(element => element.remove());
    for (const [index, message] of [...messages, ...deliveryTarget.outbox].entries()) {
      const pending = deliveryTarget.outbox.includes(message);
      const box = document.createElement('div'); box.className = 'm user queued'; box.dataset.queuedId = message.id;
      const heading = document.createElement('div'); heading.className = 'queued-heading';
      const label = document.createElement('span'); label.textContent = pending ? '전송 중' : `대기 ${index + 1}`; heading.appendChild(label);
      if (!pending) {
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '취소'; cancel.setAttribute('aria-label', `대기 메시지 ${index + 1} 취소`);
        cancel.onclick = async () => {
          const token = view, id = conversationId; cancel.disabled = true;
          try {
            await api(`/runs/${message.id}/stop`, post());
            const c: Conversation = await api(`/conversations/${id}`);
            if (token === view) { renderConversation(c); followConversation(c, token); }
          } catch (error) { if (token === view) { showError(error); cancel.disabled = false; } }
        };
        heading.appendChild(cancel);
      }
      const body = document.createElement('div'); body.innerHTML = md(message.text); box.append(heading, body); list.appendChild(box);
    }
    if (atBottom) list.scrollTop = list.scrollHeight;
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
  function markSelectedConversation() {
    historyPanel.querySelectorAll<HTMLButtonElement>('button[data-conversation-id]').forEach(button => {
      const selected = button.dataset.conversationId === conversationId;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }
  attachButton.onclick = () => toggleMenu(workspace, attachButton);
  addFiles.onclick = () => fileInput.click();
  async function upload(files: File[]) {
    if (!files.length) return;
    if (sending || uploadTask) { uploadStatus.textContent = '현재 작업이 끝나면 파일을 추가할 수 있습니다.'; return; }
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
      select.dataset.conversationId = row.id; select.setAttribute('aria-pressed', String(row.id === conversationId));
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
  function showError(e: unknown) { progress.set(String(e instanceof Error ? e.message : e)); }
  historyToggle.onclick = async () => {
    toggleMenu(historyMenu, historyToggle);
    if (!historyMenu.hidden) await refreshHistory().catch(showError);
  };
  function newConversation() {
    view++; conversationId = null; activeRun = null; busy(false); save('pr.conversation', '');
    deliveryTarget = newTarget(); queuedMessages = []; queueSignature = '';
    list.replaceChildren(); uploadedNames.length = 0; input.value = ''; resizeInput(); progress.set(''); uploadStatus.textContent = '';
    get('#conversationTitle').textContent = '새 대화'; get('#workspaceFiles').textContent = '추가한 자료가 없습니다.'; get('#fileCount').hidden = true; closeMenus();
    open(); input.focus();
    currentReport = null; reportEntries = []; activeView = 'map';
    markSelectedConversation();
  }
  get('#chatReset').onclick = newConversation;
  function renderConversation(c: Conversation) {
    reportEntries = c.reportEntries || [];
    if (currentReport && !reportEntries.some(r => r.id === currentReport!.id)) currentReport = null;
    list.replaceChildren(); c.messages.forEach(renderMessage); get('#conversationTitle').textContent = c.title;
    queueSignature = ''; renderQueued(c.queued || []);
    if (!list.childNodes.length) {
      const empty = document.createElement('div'); empty.className = 'conversation-empty';
      const title = document.createElement('strong'); title.textContent = c.title;
      const message = document.createElement('p'); message.textContent = '아직 대화 내용이 없습니다. 메시지를 입력해 대화를 이어가세요.';
      empty.append(title, message); list.appendChild(empty);
    }
    renderFiles(c);
    const report = Array.from(list.querySelectorAll<HTMLElement>('.m.report')).at(-1);
    if (report && c.messages.at(-1)?.reports?.length) { list.scrollTop = report.offsetTop - list.offsetTop; activateReport(report); }
  }
  function activateReport(element: HTMLElement) {
    const entry = reportEntries.find(r => r.id === element.dataset.reportId);
    if (!entry) return;
    const { markdown: _text, createdAt: _date, ...ref } = entry; currentReport = ref; activeView = 'report';
  }
  list.addEventListener('pointerdown', event => { const report = (event.target as HTMLElement).closest<HTMLElement>('.m.report'); if (report) activateReport(report); });
  list.addEventListener('scroll', () => {
    if (!root.classList.contains('open')) return;
    const bounds = list.getBoundingClientRect();
    const visible = Array.from(list.querySelectorAll<HTMLElement>('.m.report')).map(element => ({ element, height: Math.min(bounds.bottom, element.getBoundingClientRect().bottom) - Math.max(bounds.top, element.getBoundingClientRect().top) })).filter(x => x.height > 40).sort((a, b) => b.height - a.height)[0];
    if (visible) activateReport(visible.element);
  }, { passive: true });
  async function selectConversation(id: string) {
    const token = ++view;
    progress.set('대화 불러오는 중…'); open();
    const c: Conversation = await api(`/conversations/${id}`);
    if (view !== token) return;
    conversationId = id; currentReport = null; activeView = 'map'; save('pr.conversation', id); activeRun = null; busy(false); uploadedNames.length = 0; uploadStatus.textContent = '';
    deliveryTarget = newTarget(id);
    markSelectedConversation();
    renderConversation(c); open();
    followConversation(c, token);
    if (!activeRun) progress.set(latestRun(c)?.error ? `이전 작업 오류: ${latestRun(c).error}` : '');
  }
  function followConversation(c: Conversation, token: number) {
    const run = c.runs.find(r => ['running', 'stopping'].includes(r.status)) || c.runs.filter(r => r.status === 'queued').at(-1);
    busy(!!run || deliveryTarget.pending > 0);
    if (!run) {
      activeRun = null;
      const last = latestRun(c);
      if (last) progress.set(last.error || (last.status === 'completed' ? '완료' : last.status === 'cancelled' ? '작업 중지됨' : last.status));
      return;
    }
    if (activeRun === run.id) return;
    activeRun = run.id; progress.start({ message: run.status === 'queued' ? '메시지 대기 중' : '진행 상태 불러오는 중' });
    void poll(run.id, token);
  }
  async function ensureConversation(token: number, target = deliveryTarget) {
    if (target.id) return target.id;
    target.creation ??= api('/conversations', post()).then(c => c.id as string);
    try { target.id = await target.creation; } catch (error) { target.creation = undefined; throw error; }
    if (token === view && target === deliveryTarget) { conversationId = target.id; save('pr.conversation', target.id); }
    return target.id;
  }
  async function poll(runId: string, token: number) {
    let after = 0;
    let previousStatus = '';
    let requestVersion: number | undefined;
    let stopping = false;
    try {
      while (token === view && activeRun === runId) {
        const run = await api(`/runs/${runId}?after=${after}`);
        if (token !== view || activeRun !== runId) return;
        renderQueued(run.queued || []);
        const activity = (message: string) => progress.start({ message, startedAt: run.started_at });
        if (!after || previousStatus !== run.status) activity(run.status === 'queued' ? '메시지 대기 중' : '요청 처리 중');
        previousStatus = run.status;
        for (const event of run.events) {
          after = event.id;
          if (event.name === 'app.context') requestVersion = event.data.version;
          if (event.name === 'tool.start' || event.name === 'tool.call' || event.name === 'cli.tool') {
            const name = event.name === 'cli.tool' ? event.data.toolName || event.data.item?.tool || event.data.item?.type || event.data.type : event.data.name;
            activity(toolActivity(String(name || '')));
          }
          if (event.name === 'ingest.progress' && event.data?.message) activity(String(event.data.message));
          if (event.name === 'tool.error') progress.set(`자료 확인 실패: ${event.data.error}`);
          if (event.name === 'tool.complete') activity('결과 정리 중');
          if (event.name === 'model.request') activity('답변 준비 중');
          if (event.name === 'model.fallback') activity('모델 재연결 중');
        }
        if (!['queued','running','stopping'].includes(run.status)) {
          const c = await api(`/conversations/${conversationId}`);
          if (token !== view || activeRun !== runId) return;
          if (requestVersion === undefined || appSnapshot().version === requestVersion) exec(run.result?.actions);
          renderConversation(c);
          progress.set(run.error || (run.status === 'completed' ? '완료' : run.status === 'cancelled' ? '작업 중지됨' : run.status));
          followConversation(c, token);
          await o.refreshData(); await refreshHistory(); return;
        }
        if (run.status === 'stopping' || stopping) { stopping = true; activity('작업 중지 중'); }
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    } catch (e) {
      if (token === view) { progress.set(`${e instanceof Error ? e.message : e}\n대화 목록에서 다시 선택해 진행 상황을 복원하세요.`); busy(false); }
    }
  }
  stop.onclick = async () => {
    if (!activeRun) return;
    stop.disabled = true; progress.start({ message: '작업 중지 중' });
    try { await api(`/runs/${activeRun}/stop`, post()); } catch (e) { showError(e); } finally { stop.disabled = false; }
  };
  async function send(text: string) {
    if (uploadTask) await uploadTask;
    if (!text.trim() && !uploadedNames.length) return;
    const modelCommand = /^[!！]\s*(?:모델|model)\s*(.*)$/i.exec(text.trim());
    if (modelCommand) {
      const target = pickModel(modelCommand[1], models);
      if (!target || !setModel(target)) { progress.set('모델 이름 또는 사용 가능 여부를 확인하세요'); return; }
    }
    const wasBusy = sending, token = sending ? view : ++view, target = deliveryTarget;
    const selectedModel = model, state = { ...o.getState() }, appContext = appSnapshot();
    if (uploadedNames.length) { text += `\n\n첨부: ${uploadedNames.join(', ')}`; uploadedNames.length = 0; }
    const entry = { id: crypto.randomUUID(), text }; target.outbox.push(entry); target.pending++;
    input.value = ''; resizeInput(); open(); closeMenus(); busy(true);
    if (!wasBusy) progress.start({ message: '요청 전송 중' });
    list.querySelector('.conversation-empty')?.remove(); renderQueued(); list.scrollTop = list.scrollHeight;
    target.task = target.task.then(async () => {
      try {
        const id = await ensureConversation(token, target);
        const requestContext = { ...appContext, conversationId: id };
        if (!appContext.conversationId && token === view) {
          const current = appSnapshot();
          const comparable = (value: AppContext) => { const { version: _version, conversationId: _conversation, ...rest } = value; return JSON.stringify(rest); };
          if (comparable(current) === comparable(appContext)) requestContext.version = current.version;
        }
        const accepted = await api('/chat', post({ conversationId: id, model: selectedModel, messages: [{ role: 'user', text }], state, appContext: requestContext }));
        target.outbox = target.outbox.filter(message => message !== entry);
        if (token !== view) return;
        const c: Conversation = await api(`/conversations/${id}`);
        if (token !== view) return;
        renderConversation(c); followConversation(c, token);
        if (!activeRun) { activeRun = accepted.runId; busy(true); void poll(accepted.runId, token); }
        await refreshHistory();
      } catch (error) {
        target.outbox = target.outbox.filter(message => message !== entry);
        if (token === view) {
          showError(error);
          if (!input.value) { input.value = text; resizeInput(); }
        }
      } finally {
        target.pending--;
        if (token === view) { renderQueued(); busy(!!activeRun || target.pending > 0); }
      }
    });
    await target.task;
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
  let syncing = false;
  async function pulse() {
    if (syncing || document.hidden) return;
    syncing = true;
    try {
      await syncContext();
      const commands = await api(`/app-context/${screenId}/commands`);
      for (const command of commands) {
        const before = appSnapshot();
        let result: { status: string; detail?: string };
        if (before.version !== command.expected_version || before.conversationId !== command.conversation_id) result = { status: 'conflict', detail: '요청 이후 사용자가 화면 상태를 변경했습니다' };
        else {
          try {
            const data = command.data;
            if (data.type === 'set_map_state') {
              if ('system' in data) o.actions.set_mode(data.system);
              if ('flat' in data) o.actions.toggle_map_mode(data.flat);
              if ('country' in data) o.actions.focus_country(data.country);
            } else if (data.type === 'switch_conversation') await selectConversation(data.conversationId);
            else if (data.type === 'set_chat_model') { if (!setModel(data.model)) throw new Error('모델을 선택할 수 없습니다'); }
            else throw new Error('지원하지 않는 화면 명령');
            result = { status: 'applied' };
          } catch (error) { result = { status: 'failed', detail: String(error) }; }
        }
        await syncContext();
        await api(`/app-context/${screenId}/commands/${command.id}`, post(result));
      }
    } catch { /* 일시적인 통신 실패는 다음 주기에 재시도한다. */ }
    finally { syncing = false; }
  }
  setInterval(() => { void pulse(); }, 1000);
  void pulse();
  return { send, suggest, collapse, open, HELP, getModel: () => model, getAppContext: appSnapshot };
}
