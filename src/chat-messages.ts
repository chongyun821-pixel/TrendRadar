/** 채팅 메시지 목록 그리기: 저장된 메시지·보고서·다운로드, 대기·전송 중인 사용자 메시지 */
import { md } from './md';
import type { Conversation, Message, QueuedMessage, ReportEntry } from './chat-api';

export function createMessageList(list: HTMLElement) {
  let reportEntries: ReportEntry[] = [];
  let queueSignature = '';
  const scrollToBottom = () => { list.scrollTop = list.scrollHeight; };

  function add(role: string, html: string, modelName?: string) {
    const div = document.createElement('div'); div.className = `m ${role}`; div.innerHTML = html;
    if (modelName) div.title = modelName;
    list.appendChild(div); scrollToBottom();
    return div;
  }
  function renderMessage(message: Message) {
    if (message.role === 'user') { add('user', md(message.text)); return; }
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
      if (box.childNodes.length) { list.appendChild(box); scrollToBottom(); }
    }
  }
  /**
   * 서버 대기열(queued)과 아직 접수되지 않은 전송 중 메시지(outbox)를 목록 끝에 그린다.
   * 같은 내용이면 다시 그리지 않아 깜박이지 않는다.
   */
  function renderQueued(queued: QueuedMessage[], outbox: QueuedMessage[], onCancel: (message: QueuedMessage, index: number, button: HTMLButtonElement) => void) {
    const signature = JSON.stringify([queued, outbox]);
    if (queueSignature === signature) return;
    queueSignature = signature;
    const atBottom = list.scrollHeight - list.clientHeight - list.scrollTop < 40;
    list.querySelectorAll('.m.queued').forEach(element => element.remove());
    for (const [index, message] of [...queued, ...outbox].entries()) {
      const pending = index >= queued.length;
      const box = document.createElement('div'); box.className = 'm user queued'; box.dataset.queuedId = message.id;
      const heading = document.createElement('div'); heading.className = 'queued-heading';
      const label = document.createElement('span'); label.textContent = pending ? '전송 중' : `대기 ${index + 1}`; heading.appendChild(label);
      if (!pending) {
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '취소'; cancel.setAttribute('aria-label', `대기 메시지 ${index + 1} 취소`);
        cancel.onclick = () => onCancel(message, index, cancel);
        heading.appendChild(cancel);
      }
      const body = document.createElement('div'); body.innerHTML = md(message.text); box.append(heading, body); list.appendChild(box);
    }
    if (atBottom) scrollToBottom();
  }
  /**
   * 실행이 시작된 대기 메시지를 일반 사용자 메시지로 바꿔 그 자리에 남긴다.
   * 서버는 실행 시작 때 사용자 메시지를 저장하므로, 답변이 끝나 대화를 다시 그릴 때까지 메시지가 사라지지 않게 한다.
   */
  function promote(id: string) {
    const box = list.querySelector<HTMLElement>(`.m.queued[data-queued-id="${CSS.escape(id)}"]`);
    if (!box) return false;
    box.querySelector('.queued-heading')?.remove();
    box.classList.remove('queued'); delete box.dataset.queuedId;
    const body = box.firstElementChild;
    if (body && box.childElementCount === 1) box.innerHTML = body.innerHTML;
    return true;
  }
  function render(c: Conversation, outbox: QueuedMessage[], onCancel: Parameters<typeof renderQueued>[2]) {
    reportEntries = c.reportEntries || [];
    list.replaceChildren(); c.messages.forEach(renderMessage);
    queueSignature = ''; renderQueued(c.queued || [], outbox, onCancel);
    if (!list.childNodes.length) {
      const empty = document.createElement('div'); empty.className = 'conversation-empty';
      const title = document.createElement('strong'); title.textContent = c.title;
      const message = document.createElement('p'); message.textContent = '아직 대화 내용이 없습니다. 메시지를 입력해 대화를 이어가세요.';
      empty.append(title, message); list.appendChild(empty);
    }
  }
  function clear() { list.replaceChildren(); queueSignature = ''; reportEntries = []; }
  return {
    add, render, renderQueued, promote, clear, scrollToBottom,
    resetQueue: () => { queueSignature = ''; },
    removeEmpty: () => list.querySelector('.conversation-empty')?.remove(),
    get reportEntries() { return reportEntries; },
    set reportEntries(entries: ReportEntry[]) { reportEntries = entries; },
  };
}
