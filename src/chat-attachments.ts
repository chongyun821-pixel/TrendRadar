/** 다음 메시지에 붙일 보고서 첨부: 상태 줄에 기존 .chip 모양으로 보이고, 누르면 뺀다 */
export type ReportAttachment = { id: string; label: string };

export function createReportAttachments(box: HTMLElement) {
  let items: ReportAttachment[] = [];
  function render() {
    // 칩 앞에 빈칸을 두어 비어 있을 때 상태 줄 글자는 그대로다
    box.replaceChildren(...items.flatMap(item => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'chip'; button.dataset.reportId = item.id;
      button.textContent = `${item.label} ×`; button.title = '첨부 빼기';
      button.onclick = () => remove(item.id);
      return [' ', button];
    }));
    box.hidden = !items.length;
  }
  function remove(id: string) { items = items.filter(item => item.id !== id); render(); }
  return {
    get items() { return items; },
    add(item: ReportAttachment) { if (!items.some(i => i.id === item.id)) items = [...items, item]; render(); },
    remove,
    /** 보낼 때 꺼내고 비운다 */
    take() { const taken = items; items = []; render(); return taken; },
    clear() { items = []; render(); },
  };
}
