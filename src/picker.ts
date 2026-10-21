/** 입력창 위 인라인 선택기: 위·아래 화살표, Enter 선택, Delete 삭제, ←·Backspace(빈 입력) 이전 단계, Esc 닫기. 마우스도 지원 */
import type { PickItem } from './slash';

export interface PickerHandlers { pick(item: PickItem): void; remove?(item: PickItem): void; back?(): void; hover?(item: PickItem): void }
export function createPicker(root: HTMLElement, input: HTMLTextAreaElement) {
  let kind: string | null = null, items: PickItem[] = [], index = 0, handlers: PickerHandlers | null = null;
  root.setAttribute('role', 'listbox');
  function render(title: string) {
    root.replaceChildren();
    const head = document.createElement('div'); head.className = 'picker-title'; head.textContent = title; root.appendChild(head);
    if (!items.length) { const empty = document.createElement('div'); empty.className = 'picker-empty'; empty.textContent = '항목 없음'; root.appendChild(empty); }
    items.forEach((item, i) => {
      const row = document.createElement('div'); row.className = 'picker-item'; row.setAttribute('role', 'option'); row.id = `pick-${i}`;
      row.classList.toggle('active', i === index); row.classList.toggle('current', !!item.current); row.classList.toggle('disabled', !!item.disabled);
      row.setAttribute('aria-selected', String(i === index)); if (item.disabled) row.setAttribute('aria-disabled', 'true');
      row.dataset.id = item.id;
      const label = document.createElement('span'); label.className = 'picker-label'; label.textContent = item.label; row.appendChild(label);
      if (item.hint) { const hint = document.createElement('span'); hint.className = 'picker-hint'; hint.textContent = item.hint; row.appendChild(hint); }
      if (item.deletable && handlers?.remove) {
        const del = document.createElement('button'); del.type = 'button'; del.className = 'picker-delete'; del.textContent = '삭제'; del.setAttribute('aria-label', `${item.label} 삭제`);
        del.onpointerdown = e => e.preventDefault();
        del.onclick = e => { e.stopPropagation(); handlers?.remove?.(item); };
        row.appendChild(del);
      }
      row.onpointerdown = e => e.preventDefault(); // 입력창 초점 유지
      row.onpointerenter = () => { index = i; highlight(); handlers?.hover?.(item); };
      row.onclick = () => { if (!item.disabled) handlers?.pick(item); };
      root.appendChild(row);
    });
    input.setAttribute('aria-activedescendant', items.length ? `pick-${index}` : '');
  }
  function highlight() {
    root.querySelectorAll<HTMLElement>('.picker-item').forEach((row, i) => { row.classList.toggle('active', i === index); row.setAttribute('aria-selected', String(i === index)); });
    root.querySelector<HTMLElement>('.picker-item.active')?.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', `pick-${index}`);
  }
  function move(step: number) {
    if (!items.length) return;
    for (let n = 0; n < items.length; n++) { index = (index + step + items.length) % items.length; if (!items[index].disabled) break; }
    highlight(); handlers?.hover?.(items[index]);
  }
  input.addEventListener('keydown', e => {
    if (!kind || e.isComposing) return;
    const item = items[index];
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Enter' && !e.shiftKey) { if (item && !item.disabled) handlers?.pick(item); }
    else if (e.key === 'Escape') close();
    else if (e.key === 'Delete' && item?.deletable && handlers?.remove) handlers.remove(item);
    else if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && !input.value && handlers?.back) handlers.back();
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, { capture: true });
  function open(name: string, step: { title: string; items: PickItem[]; start?: number }, h: PickerHandlers) {
    const same = kind === name;
    kind = name; handlers = h;
    const previous = items[index]?.id;
    items = step.items;
    index = Math.max(0, same && previous !== undefined ? items.findIndex(i => i.id === previous) : step.start ?? items.findIndex(i => i.current));
    if (index < 0 || items[index]?.disabled) index = Math.max(0, items.findIndex(i => !i.disabled));
    root.hidden = false; input.setAttribute('aria-controls', root.id); input.setAttribute('aria-expanded', 'true');
    render(step.title); input.focus();
  }
  function close() {
    if (!kind) return;
    kind = null; handlers = null; items = []; root.hidden = true; root.replaceChildren();
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  }
  return { open, close, isOpen: (name?: string) => !!kind && (!name || kind === name) };
}
