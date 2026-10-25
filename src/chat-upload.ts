/** 대화 자료 추가: ＋ 메뉴의 파일 선택과 화면 전체 끌어 놓기 */
import { api } from './chat-api';

export function createUploader(o: {
  fileInput: HTMLInputElement; addFiles: HTMLButtonElement; status: HTMLElement; overlay: HTMLElement;
  /** 응답 진행 중에는 파일을 추가하지 않는다 */
  busy(): boolean;
  view(): number;
  ensureConversation(token: number): Promise<string>;
  showMenu(): void;
  /** 업로드 후 대화 자료 목록 갱신 */
  uploaded(conversationId: string, token: number): Promise<void>;
}) {
  /** 다음 메시지에 붙일 「첨부:」 이름 */
  const names: string[] = [];
  let task: Promise<void> | null = null;
  async function upload(files: File[]) {
    if (!files.length) return;
    if (o.busy() || task) { o.status.textContent = '현재 작업이 끝나면 파일을 추가할 수 있습니다.'; return; }
    o.showMenu();
    const token = o.view(); o.addFiles.disabled = true; o.status.textContent = `${files.length}개 파일 업로드 중…`;
    const current = (async () => {
      try {
        const id = await o.ensureConversation(token);
        if (token !== o.view()) return;
        const formData = new FormData(); for (const file of files) formData.append('files', file);
        const result = await api(`/conversations/${id}/files`, { method: 'POST', body: formData });
        if (token !== o.view()) return;
        names.push(...result.files.map((file: any, index: number) => `${files[index].name}${file.message ? ` (${file.message})` : ''}`));
        const notices = result.files.flatMap((file: any, index: number) => ['failed', 'unsupported'].includes(file.extraction) ? [`${files[index].name}: ${file.message}`] : []);
        o.status.textContent = [`${files.length}개 파일 추가됨`, ...notices].join('\n');
        await o.uploaded(id, token);
      } catch (e) { if (token === o.view()) o.status.textContent = `업로드 실패: ${e instanceof Error ? e.message : e}`; }
    })();
    task = current;
    try { await current; } finally { task = null; o.addFiles.disabled = o.busy(); }
  }
  o.fileInput.onchange = () => { const files = Array.from(o.fileInput.files || []); o.fileInput.value = ''; void upload(files); };
  let dragDepth = 0;
  const blocked = () => o.busy() || !!task;
  const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
  document.addEventListener('dragenter', e => {
    if (!isFileDrag(e)) return; e.preventDefault(); dragDepth++; o.overlay.hidden = false;
    o.overlay.querySelector('strong')!.textContent = blocked() ? '현재 작업이 끝난 뒤 파일을 추가하세요' : '파일을 놓아 대화에 추가';
  });
  document.addEventListener('dragover', e => { if (isFileDrag(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = blocked() ? 'none' : 'copy'; } });
  document.addEventListener('dragleave', e => { if (isFileDrag(e) && --dragDepth <= 0) { dragDepth = 0; o.overlay.hidden = true; } });
  document.addEventListener('drop', e => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth = 0; o.overlay.hidden = true; void upload(Array.from(e.dataTransfer?.files || [])); });
  window.addEventListener('blur', () => { dragDepth = 0; o.overlay.hidden = true; });
  return {
    names,
    /** 진행 중 업로드(없으면 null) */
    get task() { return task; },
    reset() { names.length = 0; o.status.textContent = ''; },
  };
}
