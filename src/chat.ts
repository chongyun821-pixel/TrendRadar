import { md } from './md';
import { HELP, type Action } from './commands';
import { resolveCountry, resolveSystem, isGeneral, seed } from '../shared/data';
import type { SystemKey } from '../shared/types';
import type { AppContext, ReportRef } from '../shared/app-context';
import type { MapDisplay, MapDisplayPatch, MapZoom } from '../shared/map-display';
import { createChatStatus, toolActivity } from './chat-status';
import { createPicker } from './picker';
import { slashSuggestions, modelStep, parseSlash, readChoice, type PickItem } from './slash';
import { checkChoice, choiceLabel, type ModelChoice } from '../shared/model-options';
import { api, post, chatBody, uploadedFiles, uploadedName, pickModel, isActiveStatus, latestRun, runStatusText, type Conversation, type ModelInfo, type QueuedMessage, type ReportEntry, type RunInfo } from './chat-api';
import { createMessageList } from './chat-messages';
import { bindTitleEditor } from './chat-title';
import { createUploader } from './chat-upload';
import { createReportAttachments } from './chat-attachments';
import { createScreenCommands, type ScreenCommand } from './screen-commands';
import { markdownToDoc } from '../shared/report-doc';
import { countryName } from '../shared/country-name';

export { pickModel, type ModelInfo };

interface ChatOpts {
  names: Record<string, string>;
  getState(): { mode: SystemKey | null; flat: boolean; focus: string | null; display: MapDisplay };
  dataVersion(): number;
  actions: { set_mode(s: SystemKey | null): void; toggle_map_mode(flat?: boolean): void; focus_country(id: string | null): void; set_display(patch: MapDisplayPatch): void; zoom(z: MapZoom): void; set_app_view(view: 'map' | 'report'): void; set_chat_open(open: boolean): void; open_search(query?: string): void; open_settings(toggle?: boolean): void };
  modeKo(): string | null;
  refreshData(): Promise<void>;
}
/**
 * 전송 중 메시지(낙관적 표시). runId: 서버가 접수한 실행. 서버 대기열에 있거나 저장본으로 그려지면(shown) 이 표시는 숨긴다.
 * cancelled: 접수 전에 중지를 눌렀다
 */
type OutboxEntry = QueuedMessage & { runId?: string; shown?: boolean; cancelled?: boolean };
/** 한 대화로 보내는 메시지 순서: 대화 생성 → 접수를 차례로 처리한다 */
type DeliveryTarget = { id: string | null; creation?: Promise<string>; pending: number; task: Promise<void>; outbox: OutboxEntry[] };
const newTarget = (id: string | null = null): DeliveryTarget => ({ id, pending: 0, task: Promise.resolve(), outbox: [] });
type CliDefaults = Partial<Record<'codex' | 'grok', { model?: string; effort?: string }>>;

export function initChat(o: ChatOpts) {
  const root = document.querySelector('#chat') as HTMLElement;
  const get = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  const list = get<HTMLElement>('#msgs'), input = get<HTMLTextAreaElement>('#q');
  const form = get<HTMLFormElement>('form');
  const status = get<HTMLElement>('#chatStatus');
  const choiceLabelEl = get<HTMLElement>('#modelLabel'), titleEl = get<HTMLElement>('#conversationTitle');
  const progress = createChatStatus(status);
  const picker = createPicker(get<HTMLElement>('#picker'), input);
  const messages = createMessageList(list);
  const stop = get<HTMLButtonElement>('#stopButton'), sendButton = get<HTMLButtonElement>('.send');
  const workspace = get<HTMLElement>('#workspace');
  const attachButton = get<HTMLButtonElement>('#attachButton'), addFiles = get<HTMLButtonElement>('#addFiles');
  let conversationId: string | null = null, activeRun: string | null = null, view = 0, sending = false, keepCollapsedUntilTerminal = false;
  let deliveryTarget = newTarget();
  let queuedMessages: QueuedMessage[] = [];
  let models: ModelInfo[] = [{ id: 'gpt', name: '지피티', available: true }], choice: ModelChoice = { provider: 'gpt' }, cliDefaults: CliDefaults = {};
  const screenId = crypto.randomUUID();
  let activeView: 'map' | 'report' = 'map', currentReport: ReportRef | null = null;

  /* ───────── 화면 맥락 ───────── */
  function appSnapshot(): AppContext {
    const map = o.getState();
    return { screenId, conversationId, model: choice.provider, ...(choice.model || choice.effort ? { modelOptions: { ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}) } } : {}), activeView, ...map, filters: { system: map.mode }, report: currentReport, dataVersion: o.dataVersion() };
  }
  addEventListener('radar:map-state', () => { activeView = 'map'; });

  /* ───────── 모델 선택 ───────── */
  const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* 저장 제한 */ } };
  const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
  const showChoice = () => { choiceLabelEl.textContent = choiceLabel(choice, choice.provider === 'codex' || choice.provider === 'grok' ? cliDefaults[choice.provider] : undefined); };
  /** 모델 선택(제공자, CLI 모델, 추론 강도). 전역 마지막 선택과 대화별 선택을 함께 저장하고, 다음 요청부터 그대로 서버에 보낸다 */
  function setChoice(next: ModelChoice | null, persist = true) {
    if (!next || !models.some(m => m.id === next.provider && m.available)) return false;
    choice = next; showChoice();
    if (persist) { save('pr.model', JSON.stringify(choice)); if (conversationId) save(`pr.model.${conversationId}`, JSON.stringify(choice)); }
    return true;
  }
  const setModel = (id: string, cliModel?: string, effort?: string) => {
    const r = checkChoice({ provider: id, model: cliModel, effort });
    return r.ok && setChoice(r.choice);
  };
  api('/models').then(j => {
    models = j.models; cliDefaults = j.defaults || {};
    const saved = (conversationId && readChoice(read(`pr.model.${conversationId}`))) || readChoice(read('pr.model'));
    if (!setChoice(saved, false)) setChoice({ provider: j.default }, false);
    showChoice();
  }).catch(e => { progress.set(e.message); });
  showChoice();

  /* ───────── 입력창, 메뉴 ───────── */
  const open = () => { if (!keepCollapsedUntilTerminal) root.classList.add('open'); };
  const openFromUser = () => { keepCollapsedUntilTerminal = false; root.classList.add('open'); };
  const openForTerminal = () => { keepCollapsedUntilTerminal = false; root.classList.add('open'); };
  const collapse = () => { if (activeRun) keepCollapsedUntilTerminal = true; root.classList.remove('open'); closeMenus(); input.blur(); activeView = 'map'; };
  const setChatOpen = (isOpen: boolean, focusInput = false) => { if (isOpen) { open(); if (focusInput && !keepCollapsedUntilTerminal) input.focus(); } else collapse(); };
  function closeMenus() {
    workspace.hidden = true; picker.close();
    attachButton.setAttribute('aria-expanded', 'false');
  }
  function toggleMenu(menu: HTMLElement, button: HTMLElement) {
    const show = menu.hidden; closeMenus(); menu.hidden = !show; button.setAttribute('aria-expanded', String(show));
  }
  root.querySelectorAll<HTMLButtonElement>('.menu-close').forEach(button => button.onclick = closeMenus);
  document.addEventListener('pointerdown', e => { if (!get('.composer').contains(e.target as Node)) closeMenus(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && (picker.isOpen() || !workspace.hidden)) { closeMenus(); input.focus(); }
  });
  function resizeInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(150, Math.max(34, input.scrollHeight))}px`;
  }
  function clearInput() { input.value = ''; resizeInput(); }
  input.addEventListener('input', resizeInput);
  // / 로 시작하면 명령 후보를 보이고, 다른 내용을 입력하면 열린 선택기를 닫는다
  input.addEventListener('input', () => {
    if (slashSuggestions(input.value).length) openSlashHints();
    else if (picker.isOpen('slash') || (input.value.trim() && picker.isOpen())) picker.close();
  });
  input.addEventListener('input', updateSendButton);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('focus', openFromUser);
  get('#chatToggle').addEventListener('click', () => { if (root.classList.contains('open')) collapse(); else openFromUser(); });
  document.querySelector('#globe')!.addEventListener('pointerdown', () => { if (!input.value && !activeRun) collapse(); });

  function exec(actions: Action[] = []) {
    for (const a of actions) {
      if (a.type === 'set_mode') o.actions.set_mode(a.system && !isGeneral(a.system) ? resolveSystem(a.system) : null);
      else if (a.type === 'toggle_map_mode') o.actions.toggle_map_mode(a.flat);
      else if (a.type === 'focus_country') { const country = resolveCountry(a.country, o.names); if (country) o.actions.focus_country(country); }
      else if (a.type === 'set_display') o.actions.set_display(a.display);
      else if (a.type === 'zoom') o.actions.zoom(a.zoom);
      else if (a.type === 'set_app_view') setAppView(a.view);
      else if (a.type === 'open_report_editor') { const entry = messages.reportEntries.find(r => r.id === currentReport?.id); if (entry) dispatchEditor(entry); else dispatchEvent(new Event('radar:open-ranking-report-editor')); }
      else if (a.type === 'close_report_editor') dispatchEvent(new Event('radar:close-report-editor'));
      else if (a.type === 'set_chat_open') o.actions.set_chat_open(a.open);
      else if (a.type === 'open_search') o.actions.open_search(a.query);
      else if (a.type === 'open_settings') o.actions.open_settings(a.toggle);
    }
  }
  function setAppView(view: 'map' | 'report') {
    o.actions.set_app_view(view);
    activeView = view === 'report' && currentReport ? 'report' : 'map';
  }
  function busy(on: boolean) {
    if (on && !root.classList.contains('open')) keepCollapsedUntilTerminal = true;
    sending = on; root.classList.toggle('busy', on); stop.hidden = !on; updateSendButton();
    addFiles.disabled = on || !!uploader.task;
  }
  function updateSendButton() { sendButton.hidden = sending && !input.value.trim(); }
  function showError(e: unknown) { openForTerminal(); progress.set(String(e instanceof Error ? e.message : e)); }

  /* ───────── 메시지 목록 ───────── */
  /** 대기 메시지 취소: 서버에서 실행하지 않고 취소한 뒤 대화를 다시 그린다 */
  async function cancelQueued(message: QueuedMessage, _index: number, button: HTMLButtonElement) {
    const token = view, id = conversationId; button.disabled = true;
    try {
      await api(`/runs/${message.id}/stop`, post());
      const c: Conversation = await loadConversation(id!, true);
      if (token === view) { renderConversation(c); followConversation(c, token); }
    } catch (error) { if (token === view) { showError(error); button.disabled = false; } }
  }
  /** 서버가 이미 보여주는 메시지(대기열에 있거나 대화 저장본에 실행 기록이 있는 요청)와 겹치지 않는 전송 중 메시지 */
  function visibleOutbox(queued: QueuedMessage[], runs?: RunInfo[]) {
    const queuedIds = new Set(queued.map(q => q.id)), known = new Set((runs || []).map(r => r.id));
    for (const entry of deliveryTarget.outbox) if (entry.runId && known.has(entry.runId)) entry.shown = true;
    return deliveryTarget.outbox.filter(entry => !entry.shown && !(entry.runId && queuedIds.has(entry.runId)));
  }
  function renderQueued(queued: QueuedMessage[] = queuedMessages) {
    queuedMessages = queued;
    messages.renderQueued(queued, visibleOutbox(queued), cancelQueued);
    markProgrammaticScroll();
  }
  /** 다시 그리면서 생긴 스크롤은 사용자가 보고서를 본 것으로 치지 않는다(완료 후 사용자가 바꾼 지도 화면 유지) */
  let programmaticScroll = -1;
  function markProgrammaticScroll() { programmaticScroll = list.scrollTop; }
  function renderFiles(c: Conversation) {
    const box = get('#workspaceFiles'); box.replaceChildren();
    const visible = uploadedFiles(c.files);
    const count = get('#fileCount'); count.textContent = String(visible.length); count.hidden = !visible.length;
    if (!visible.length) box.textContent = '추가한 자료가 없습니다.';
    for (const f of visible) {
      const a = document.createElement('a'); a.href = `/api/conversations/${c.id}/files/${f.id}`;
      a.textContent = `${uploadedName(f.name)}${f.error ? ' (추출 오류)' : ''}`;
      a.title = f.error || f.name; a.download = ''; box.appendChild(a);
    }
  }
  function renderConversation(c: Conversation, activateLatestReport = true) {
    queuedMessages = c.queued || [];
    const missing = viewedReports.filter(r => !c.reportEntries?.some(e => e.id === r.id));
    if (missing.length) c = { ...c, reportEntries: [...(c.reportEntries || []), ...missing] };
    messages.render(c, visibleOutbox(queuedMessages, c.runs), cancelQueued);
    if (currentReport && !messages.reportEntries.some(r => r.id === currentReport!.id)) currentReport = null;
    titleEl.textContent = c.title;
    renderFiles(c);
    const report = Array.from(list.querySelectorAll<HTMLElement>('.m.report')).at(-1);
    if (activateLatestReport && report && c.messages.at(-1)?.reports?.length) { list.scrollTop = report.offsetTop - list.offsetTop; activateReport(report); }
    markProgrammaticScroll();
  }
  function activateReport(element: HTMLElement) {
    const entry = messages.reportEntries.find(r => r.id === element.dataset.reportId);
    if (!entry) return;
    const { markdown: _text, createdAt: _date, ...ref } = entry; currentReport = ref; activeView = 'report';
    if (!element.querySelector('.report-export-button')) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'report-export-button'; button.textContent = 'Word로 내보내기';
      button.title = '최신 공개 자료를 다시 조사해 AI가 Word 보고서를 작성합니다';
      button.addEventListener('click', event => { event.stopPropagation(); requestWordExport(entry); }); element.prepend(button);
    }
  }
  function requestWordExport(entry: ReportEntry) {
    requestWordExportForScope(entry.country || o.getState().focus, entry.system);
  }
  function requestWordExportForScope(country: string | null, system: SystemKey | null) {
    openFromUser();
    if (choice.provider !== 'codex' && choice.provider !== 'grok') {
      progress.set('Word 작성에는 문서 작성 도구가 있는 Codex 또는 Grok Build가 필요합니다. /models에서 선택해 주세요.');
      openModels();
      return;
    }
    if (!country) { progress.set('보고서의 국가 범위를 확인할 수 없습니다.'); return; }
    const countryLabel = o.names[country] || countryName(country, seed);
    const systemLabel = system ? seed.systems[system]?.ko || system : '전체 무기체계';
    const prompt = [
      '현재 표시 중인 보고서 카드는 대상과 범위를 확인하는 용도로만 사용하고, 본문을 그대로 Word로 변환하지 마세요.',
      '이번 요청 시점의 최신 공개 자료를 새로 검색하고 원문을 확인한 뒤, 챗봇이 한국어 편집 가능 Word(.docx) 보고서를 직접 작성해 주세요.',
      `대상 국가: ${countryLabel} (${country})`,
      `대상 체계: ${systemLabel}${system ? ` (${system})` : ' (general, 국가의 해당 자료 전체)'}`,
      '사실과 추정, 미확인 사항을 구분하고 출처 URL과 발행일을 문서에 표시하세요. 확인할 수 없는 내용은 만들지 말고 한계로 적으세요.',
      `get_report_template에서 word-country-v1 양식을 확인하고, prepare_report에 country="${country}", system="${system || 'general'}", basis="latest"를 지정해 최신 작성 자료를 받으세요. 기존 보고서 본문을 재사용하지 말고 이번에 새로 조사한 자료로 내용을 구성하세요.`,
      'Codex Documents 또는 Grok Build의 기본 docx 작성 도구로 대화 작업 폴더 reports/에 편집 가능한 Word 파일을 만드세요. 렌더링 후 내용과 레이아웃을 확인하고, 검수 결과와 preparationId를 넣어 publish_artifact로 등록하세요. 완료되면 실제 다운로드 링크를 답하세요.',
      '이 요청은 문서 작성만 수행합니다. 조달 운영 DB의 장비·사업 자료는 변경하거나 apply_research로 반영하지 마세요.',
    ].join('\n');
    void send(prompt, { attachPending: false, preserveComposer: true });
  }
  function dispatchEditor(entry: ReportEntry) {
    const title = [entry.country ? o.names[entry.country] || countryName(entry.country, seed) : null, entry.system ? seed.systems[entry.system]?.ko : null, '분석 보고서'].filter(Boolean).join(' ');
    const sourceRef = [entry.country ? o.names[entry.country] || countryName(entry.country, seed) : null, entry.system ? seed.systems[entry.system]?.ko : null].filter(Boolean).join(' ');
    dispatchEvent(new CustomEvent('radar:open-report-editor', { detail: markdownToDoc(entry.markdown, title, entry.id, sourceRef) }));
  }
  list.addEventListener('pointerdown', event => { const report = (event.target as HTMLElement).closest<HTMLElement>('.m.report'); if (report) activateReport(report); });
  list.addEventListener('scroll', () => {
    if (!root.classList.contains('open') || Math.abs(list.scrollTop - programmaticScroll) < 1) return;
    const bounds = list.getBoundingClientRect();
    const visible = Array.from(list.querySelectorAll<HTMLElement>('.m.report')).map(element => ({ element, height: Math.min(bounds.bottom, element.getBoundingClientRect().bottom) - Math.max(bounds.top, element.getBoundingClientRect().top) })).filter(x => x.height > 40).sort((a, b) => b.height - a.height)[0];
    if (visible) activateReport(visible.element);
  }, { passive: true });

  /* ───────── 자료 추가 ───────── */
  attachButton.onclick = () => toggleMenu(workspace, attachButton);
  const fileInput = get<HTMLInputElement>('#fileInput');
  addFiles.onclick = () => fileInput.click();
  const uploader = createUploader({
    fileInput, addFiles, status: get<HTMLElement>('#uploadStatus'), overlay: get('#dropOverlay'),
    busy: () => sending, view: () => view, ensureConversation: token => ensureConversation(token),
    showMenu: () => { closeMenus(); workspace.hidden = false; attachButton.setAttribute('aria-expanded', 'true'); },
    uploaded: async (id, token) => {
      const conversation = await loadConversation(id, true);
      if (token !== view) return;
      renderFiles(conversation); await refreshHistory();
    },
  });

  /* ───────── 지도에서 연 보고서: 채팅 요청 없이 표시만 한다(채팅 첨부는 자동으로 넣지 않는다) ───────── */
  const reportAttachments = createReportAttachments(get('#attachments'));
  /** 이 화면에서 연 보고서. 서버 저장본을 받기 전에 다시 그려도 사라지지 않게 한다 */
  let viewedReports: ReportEntry[] = [];
  async function viewReport(country: string, system: SystemKey | null): Promise<ReportEntry | null> {
    const token = view;
    try {
      const id = await ensureConversation(token);
      const entry: ReportEntry = await api(`/conversations/${id}/reports`, post({ country, system }));
      if (token !== view) return null;
      if (!viewedReports.some(r => r.id === entry.id)) viewedReports.push(entry);
      if (!messages.reportEntries.some(r => r.id === entry.id)) messages.reportEntries = [...messages.reportEntries, entry];
      let element = list.querySelector<HTMLElement>(`.m.report[data-report-id="${CSS.escape(entry.id)}"]`);
      if (!element) { messages.removeEmpty(); element = messages.addReport(entry); }
      activateReport(element); list.scrollTop = element.offsetTop - list.offsetTop; markProgrammaticScroll();
      void screen.sync();
      return entry;
    } catch (error) { if (token === view) showError(error); return null; }
  }
  async function attachReport(country: string, system: SystemKey) {
    openFromUser();
    const token = view;
    try {
      const id = await ensureConversation(token);
      const entry: ReportEntry = await api(`/conversations/${id}/reports`, post({ country, system }));
      if (token !== view) return;
      reportAttachments.add({ id: entry.id, label: `${o.names[country] || country} ${seed.systems[system]?.ko || system} 보고서` });
    } catch (error) { if (token === view) showError(error); }
  }

  /* ───────── 대화 목록, 전환 ───────── */
  /** 대화 캐시: 전환 즉시 마지막으로 받은 내용을 보여주고 최신 내용은 뒤에서 받는다 */
  const conversations = new Map<string, Conversation>(), loading = new Map<string, Promise<Conversation>>();
  let historyRows: { id: string; title: string }[] = [];
  function loadConversation(id: string, fresh = false) {
    let task = fresh ? undefined : loading.get(id);
    if (!task) {
      task = api(`/conversations/${id}`).then((c: Conversation) => { conversations.set(id, c); return c; }).finally(() => { if (loading.get(id) === task) loading.delete(id); });
      loading.set(id, task);
    }
    return task;
  }
  /** 낙관적 삭제: 목록과 화면에서 바로 지우고, 실패하면 목록을 되돌리고 짧게 알린다 */
  function deleteConversation(id: string) {
    historyRows = historyRows.filter(r => r.id !== id);
    const cached = conversations.get(id); conversations.delete(id);
    const open = picker.isOpen('sessions');
    if (id === conversationId) newConversation();
    if (open) openSessions(false);
    void api(`/conversations/${id}`, { method: 'DELETE' }).catch(() => {
      if (cached) conversations.set(id, cached);
      progress.set('대화 삭제 실패');
      void refreshHistory().catch(() => {});
    });
  }
  async function refreshHistory() {
    const rows: { id: string; title: string }[] = await api('/conversations');
    historyRows = rows;
    if (picker.isOpen('sessions')) openSessions(false);
    return rows;
  }
  /** /sessions: 새 대화, 대화 전환, 삭제(낙관적). 목록은 저장본을 바로 보이고 최신 목록으로 갱신한다 */
  function openSessions(refresh = true) {
    const items: PickItem[] = [{ id: '', label: '＋ 새 대화' }, ...historyRows.map(r => ({ id: r.id, label: r.title, current: r.id === conversationId, deletable: true }))];
    picker.open('sessions', { title: '↑↓로 이동, Enter로 열기, Delete로 삭제', items, start: 0 }, {
      pick: item => { picker.close(); if (!item.id) newConversation(); else void selectConversation(item.id).catch(showError); },
      remove: item => { if (item.id) deleteConversation(item.id); },
      hover: item => { if (item.id && !conversations.has(item.id)) void loadConversation(item.id).catch(() => {}); },
    });
    if (refresh) void refreshHistory().catch(showError);
  }
  /** / 명령 자동완성: Tab 완성, ↑↓ 이동, Enter, 클릭 실행, Esc 닫기 */
  function openSlashHints() {
    const items: PickItem[] = slashSuggestions(input.value).map(s => ({ id: s.name, label: s.command, hint: s.desc }));
    const run = (item: PickItem) => { input.value = `/${item.id}`; void send(input.value).catch(showError); };
    picker.open('slash', { title: '명령 (Tab으로 완성)', items, start: 0, reset: true }, {
      pick: run,
      tab: item => { input.value = `/${item.id}`; resizeInput(); updateSendButton(); openSlashHints(); },
    });
  }
  /** 대화 제목 바로 변경: 화면을 먼저 바꾸고 실패하면 되돌린다 */
  function setRowTitle(id: string, title: string) {
    const row = historyRows.find(r => r.id === id);
    if (row) row.title = title; else historyRows.unshift({ id, title });
    const cached = conversations.get(id); if (cached) conversations.set(id, { ...cached, title });
    if (picker.isOpen('sessions')) openSessions(false);
  }
  async function renameConversation(title: string, previous: string) {
    const token = view;
    let id: string;
    try { id = conversationId ?? await ensureConversation(token); } catch { if (token === view) titleEl.textContent = previous; progress.set('제목 변경 실패'); return; }
    const before = historyRows.find(r => r.id === id)?.title ?? previous;
    setRowTitle(id, title);
    try { await api(`/conversations/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }); }
    catch {
      setRowTitle(id, before);
      if (conversationId === id && titleEl.textContent === title) titleEl.textContent = before;
      progress.set('제목 변경 실패');
    }
  }
  bindTitleEditor(titleEl, { onEdit: () => picker.close(), rename: (next, previous) => { void renameConversation(next, previous); } });
  choiceLabelEl.addEventListener('click', () => openModels());
  // ^: /sessions 선택기(다시 누르면 닫기)
  get('#sessionsButton').addEventListener('click', () => { if (picker.isOpen('sessions')) picker.close(); else { openFromUser(); openSessions(); } });
  /** /models: 제공자 → (코덱스, 그록 빌드) 모델 → 추론 강도 */
  function openModels(path: string[] = []) {
    const step = modelStep(path, choice, new Set(models.filter(m => m.available).map(m => m.id)));
    if ('done' in step) { picker.close(); if (!setChoice(step.done)) progress.set('사용할 수 없는 모델'); return; }
    picker.open('models', { ...step, title: `${step.title} (↑↓로 이동, Enter로 선택${path.length ? ', ←로 이전' : ''})` }, {
      pick: item => { if (!item.disabled) openModels([...path, item.id]); },
      back: path.length ? () => openModels(path.slice(0, -1)) : undefined,
    });
  }
  /** 화면 전환 공통: 진행 표시, 전송 대상, 자료 상태를 대화에 맞게 초기화한다 */
  function resetSession(id: string | null) {
    // 보고서 첨부는 그 대화의 다음 메시지에만 붙는다
    if (id !== conversationId || !id) { reportAttachments.clear(); viewedReports = []; }
    conversationId = id; activeRun = null; busy(false);
    deliveryTarget = newTarget(id); queuedMessages = []; messages.resetQueue();
    currentReport = null; activeView = 'map';
  }
  function newConversation(reveal = true) {
    view++; resetSession(null); save('pr.conversation', '');
    messages.clear(); uploader.reset(); clearInput(); progress.set('');
    titleEl.textContent = '새 대화'; get('#workspaceFiles').textContent = '추가한 자료가 없습니다.'; get('#fileCount').hidden = true; closeMenus();
    if (reveal) { openFromUser(); input.focus(); }
  }
  /** 낙관적 전환: 바로 선택을 바꾸고 캐시(없으면 제목만)를 보여준 뒤 최신 내용으로 갱신한다. 실패하면 이전 대화로 되돌린다 */
  async function selectConversation(id: string, reveal = true) {
    const token = ++view, previous = conversationId;
    const show = (c: Conversation) => {
      resetSession(c.id); save('pr.conversation', c.id); uploader.reset();
      setChoice(readChoice(read(`pr.model.${c.id}`)), false); renderConversation(c); if (reveal) openFromUser();
    };
    const cached = conversations.get(id);
    if (cached) show(cached);
    else {
      resetSession(id); messages.clear();
      titleEl.textContent = historyRows.find(r => r.id === id)?.title || '대화'; if (reveal) openFromUser();
      progress.set('대화 불러오는 중…');
    }
    let c: Conversation;
    try { c = await loadConversation(id); }
    catch (e) {
      if (view !== token) return;
      const back = previous && conversations.get(previous);
      if (back) { view++; show(back); followConversation(back, view); } else newConversation(reveal);
      progress.set(`대화를 열지 못했습니다${e instanceof Error && e.message ? `: ${e.message}` : ''}`);
      return;
    }
    if (view !== token) return;
    show(c);
    followConversation(c, token);
    if (!activeRun) progress.set(latestRun(c)?.error ? `이전 작업 오류: ${latestRun(c).error}` : '');
  }

  /* ───────── 실행 추적, 중지 ───────── */
  /** 실행 중이거나 가장 먼저 대기한 요청을 따라간다(대기열은 FIFO, runs는 최신순) */
  function followConversation(c: Conversation, token: number) {
    const run = c.runs.find(r => ['running', 'stopping'].includes(r.status)) || c.runs.filter(r => r.status === 'queued').at(-1);
    busy(!!run || deliveryTarget.pending > 0);
    if (!run) {
      activeRun = null;
      const last = latestRun(c);
      if (last) progress.set(runStatusText(last));
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
    if (token === view && target === deliveryTarget) { conversationId = target.id; save('pr.conversation', target.id); save(`pr.model.${target.id}`, JSON.stringify(choice)); }
    return target.id;
  }
  async function poll(runId: string, token: number) {
    let after = 0;
    let previousStatus = '';
    let stopping = false;
    const current = () => token === view && activeRun === runId;
    try {
      while (current()) {
        const run = await api(`/runs/${runId}?after=${after}`);
        if (!current()) return;
        // 실행이 시작되면 서버가 사용자 메시지를 저장한다. 대기 표시를 일반 메시지로 바꿔 답변이 끝날 때까지 보이게 한다.
        if (run.status !== 'queued') messages.promote(runId);
        renderQueued(run.queued || []);
        const activity = (message: string) => progress.start({ message, startedAt: run.started_at });
        if (!after || previousStatus !== run.status) activity(run.status === 'queued' ? '메시지 대기 중' : '요청 처리 중');
        previousStatus = run.status;
        for (const event of run.events) {
          after = event.id;
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
        if (!isActiveStatus(run.status)) {
          // 접힌 창도 응답이 끝나면(답변, 보고서만 있는 답, 오류) 펼쳐 보여준다. 대화를 다시 불러오다 실패해도 펼친다(사용자 중지, 취소는 그대로 둔다)
          if (run.status === 'failed' || run.status === 'completed') openForTerminal();
          else keepCollapsedUntilTerminal = false;
          const c = await loadConversation(conversationId!, true);
          if (!current()) return;
          // 답과 함께 온 화면 동작(화면 연결이 없을 때 남긴 것)은 사용자가 그사이 화면을 바꿨더라도 적용한다
          exec(run.result?.actions);
          renderConversation(c);
          progress.set(runStatusText(run));
          followConversation(c, token);
          await o.refreshData(); await refreshHistory(); return;
        }
        if (run.status === 'stopping' || stopping) { stopping = true; activity('작업 중지 중'); }
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    } catch (e) {
      if (token === view) {
        openForTerminal();
        progress.set(`${e instanceof Error ? e.message : e}\n대화 목록에서 다시 선택해 진행 상황을 복원하세요.`);
        if (activeRun === runId) activeRun = null;
        busy(deliveryTarget.pending > 0);
      }
    }
  }
  /**
   * 중지: 진행 중(또는 첫 대기) 요청을 서버에서 중지한다. 서버는 모델 호출과 CLI 프로세스 트리를 끝내고 중지됨으로 저장한다.
   * 아직 접수되지 않은 전송 중 메시지는 접수 즉시 취소하도록 표시한다.
   */
  stop.onclick = async () => {
    const runId = activeRun;
    if (!runId) {
      const waiting = deliveryTarget.outbox.filter(entry => !entry.cancelled);
      if (!waiting.length) return;
      for (const entry of waiting) entry.cancelled = true;
      progress.start({ message: '작업 중지 중' });
      return;
    }
    stop.disabled = true; progress.start({ message: '작업 중지 중' });
    try { await api(`/runs/${runId}/stop`, post()); } catch (e) { showError(e); } finally { stop.disabled = false; }
  };

  /* ───────── 전송 ───────── */
  async function send(text: string, options: { attachPending?: boolean; preserveComposer?: boolean } = {}) {
    const attachPending = options.attachPending !== false;
    if (attachPending && uploader.task) await uploader.task;
    if (!text.trim() && (!attachPending || (!uploader.names.length && !reportAttachments.items.length))) return;
    const slash = parseSlash(text);
    if (slash) {
      clearInput(); updateSendButton(); openFromUser();
      if (slash.cmd === 'sessions') openSessions();
      else if (slash.cmd === 'models') openModels();
      else if (slash.cmd === 'settings') o.actions.open_settings();
      else o.actions.open_search();
      return;
    }
    const modelCommand = /^[!！]\s*(?:모델|model)\s*(.*)$/i.exec(text.trim());
    if (modelCommand) {
      const target = pickModel(modelCommand[1], models);
      if (!target || !setModel(target)) { progress.set('모델 이름 또는 사용 가능 여부를 확인하세요'); return; }
    }
    const wasBusy = sending, token = sending ? view : ++view, target = deliveryTarget;
    const selectedChoice = choice, state = { ...o.getState() }, appContext = appSnapshot();
    const typed = text, files = attachPending ? [...uploader.names] : [], reports = attachPending ? reportAttachments.take() : [], attached = [...files, ...reports.map(r => r.label)];
    if (attached.length) { text = `${text.trim() ? `${text}\n\n` : ''}첨부: ${attached.join(', ')}`; uploader.names.length = 0; }
    // 낙관적 표시: 보내는 즉시 「전송 중」으로 보이고, 서버 저장본으로 다시 그릴 때 한 번에 바꾼다.
    const entry: OutboxEntry = { id: crypto.randomUUID(), text }; target.outbox.push(entry); target.pending++;
    const dropEntry = () => { target.outbox = target.outbox.filter(message => message !== entry); };
    if (!options.preserveComposer) clearInput();
    openFromUser(); closeMenus(); busy(true);
    if (!wasBusy) progress.start({ message: '요청 전송 중' });
    messages.removeEmpty(); renderQueued(); messages.scrollToBottom();
    target.task = target.task.then(async () => {
      try {
        if (entry.cancelled) { dropEntry(); if (token === view) progress.set('작업 중지됨'); return; }
        const id = await ensureConversation(token, target);
        const requestContext = { ...appContext, conversationId: id };
        const accepted = await api('/chat', post(chatBody(selectedChoice, id, text, state, requestContext, reports.map(r => r.id))));
        entry.runId = accepted.runId;
        // 접수 전에 중지를 눌렀으면 바로 취소한다(대기 중이면 실행하지 않는다).
        if (entry.cancelled) await api(`/runs/${accepted.runId}/stop`, post()).catch(showError);
        if (token !== view) { dropEntry(); return; }
        const c: Conversation = await loadConversation(id!, true);
        // 서버 저장본(대기 또는 시작된 메시지)을 그리는 순간 전송 중 표시를 뺀다: 중복, 깜박임 없음
        dropEntry();
        if (token !== view) return;
        renderConversation(c); followConversation(c, token);
        if (!activeRun && !entry.cancelled) { activeRun = accepted.runId; busy(true); void poll(accepted.runId, token); }
        await refreshHistory();
      } catch (error) {
        dropEntry();
        if (token === view) {
          showError(error);
          if (!options.preserveComposer && !input.value) { input.value = typed; resizeInput(); }
          for (const report of reports) reportAttachments.add(report);
          if (!uploader.names.length) uploader.names.push(...files);
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
    if (view === 0 && id && rows.some(r => r.id === id)) return selectConversation(id, false);
  }).catch(showError);
  function suggest(id: string | null) {
    const box = get('#suggest'); box.replaceChildren(); box.classList.remove('show');
    if (!id || !seed.records.some(r => r.country === id)) return;
    const label = `${o.names[id] || id}${o.modeKo() ? ` ${o.modeKo()}` : ''} 보고서`;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.onclick = () => { openFromUser(); void viewReport(id, o.getState().mode); };
    box.appendChild(button); box.classList.add('show');
  }

  /* ───────── 화면 명령(MCP, 모델이 요청한 지도, 보고서, 대화, 모델 전환) ───────── */
  async function applyCommand(command: ScreenCommand) {
    const data = command.data;
    if (data.type === 'show_report') {
      // 보고서는 그 대화에 있다. 다른 대화를 보고 있으면 그 대화로 전환한 뒤 표시한다
      if (data.conversationId && data.conversationId !== conversationId) {
        await selectConversation(data.conversationId, false);
        if (conversationId !== data.conversationId) throw new Error('보고서가 있는 대화를 열지 못했습니다');
      }
      const id = conversationId!, c = await loadConversation(id, true);
      if (conversationId !== id) throw new Error('보고서를 불러오는 동안 대화가 바뀌었습니다');
      const entry = c.reportEntries?.find(r => r.id === data.reportId);
      if (!entry) throw new Error('표시할 보고서를 찾을 수 없습니다');
      messages.reportEntries = c.reportEntries!;
      o.actions.set_mode(data.system); o.actions.focus_country(data.country);
      let element = list.querySelector<HTMLElement>(`[data-report-id="${entry.id}"]`);
      if (!element) { messages.removeEmpty(); element = messages.add('report', md(entry.markdown)); element.dataset.reportId = entry.id; }
      activateReport(element); list.scrollTop = element.offsetTop - list.offsetTop;
    } else if (data.type === 'set_map_state') {
      if ('system' in data) o.actions.set_mode(data.system);
      if ('flat' in data) o.actions.toggle_map_mode(data.flat);
      if (data.display) o.actions.set_display(data.display);
      if ('country' in data) o.actions.focus_country(data.country);
      if (data.zoom != null) o.actions.zoom(data.zoom);
    } else if (data.type === 'set_app_view') setAppView(data.view);
    else if (data.type === 'open_report_editor') { const entry = messages.reportEntries.find(r => r.id === currentReport?.id); if (entry) dispatchEditor(entry); else dispatchEvent(new Event('radar:open-ranking-report-editor')); }
    else if (data.type === 'close_report_editor') dispatchEvent(new Event('radar:close-report-editor'));
    else if (data.type === 'set_chat_open') o.actions.set_chat_open(data.open);
    else if (data.type === 'open_search') o.actions.open_search(data.query);
    else if (data.type === 'open_settings') o.actions.open_settings(data.toggle);
    else if (data.type === 'switch_conversation') await selectConversation(data.conversationId, false);
    else if (data.type === 'set_chat_model') { if (!setModel(data.model, data.cliModel, data.effort)) throw new Error('모델을 선택할 수 없습니다'); }
    else throw new Error('지원하지 않는 화면 명령');
  }
  const screen = createScreenCommands({ screenId, snapshot: appSnapshot, apply: applyCommand });
  screen.start();
  return { send, viewReport, attachReport, exportWordReport: requestWordExportForScope, suggest, collapse, open, setChatOpen, focusInput: () => input.focus(), dispatch: exec, openModels, HELP, getModel: () => choice.provider, getAppContext: appSnapshot };
}
