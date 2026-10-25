/** 대화 제목: 눌러서 바로 고친다. Enter, 초점 이동 저장, Esc 취소, 빈 값은 되돌림 */
export function bindTitleEditor(titleEl: HTMLElement, o: { onEdit(): void; rename(next: string, previous: string): void }) {
  let before = '', cancelled = false;
  titleEl.addEventListener('click', () => {
    if (titleEl.isContentEditable) return;
    o.onEdit(); before = titleEl.textContent || ''; cancelled = false;
    try { titleEl.contentEditable = 'plaintext-only'; } catch { titleEl.contentEditable = 'true'; }
    if (!titleEl.isContentEditable) titleEl.contentEditable = 'true';
    titleEl.focus();
    const range = document.createRange(); range.selectNodeContents(titleEl);
    const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  });
  titleEl.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelled = true; titleEl.blur(); }
  });
  titleEl.addEventListener('blur', () => {
    if (!titleEl.isContentEditable) return;
    titleEl.contentEditable = 'false'; titleEl.scrollLeft = 0;
    const next = (titleEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (cancelled || !next || next === before) { titleEl.textContent = before; return; }
    titleEl.textContent = next;
    o.rename(next, before);
  });
}
