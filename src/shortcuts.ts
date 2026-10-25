export type ShortcutAction = 'chat' | 'report' | 'map' | 'globe' | 'search' | 'settings' | 'escape';

export interface ShortcutKeyEvent {
  key: string;
  code?: string;
  isComposing?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export function shortcutAction(event: ShortcutKeyEvent, weaponCount: number): ShortcutAction | { type: 'weapon'; index: number } | null {
  const key = event.key;
  const code = event.code;
  if (code === 'Escape' || key === 'Escape') return 'escape';
  if (event.isComposing) return null;
  if ((event.metaKey || event.ctrlKey) && (key === ',' || code === 'Comma') && !event.altKey && !event.shiftKey) return 'settings';
  if ((event.metaKey || event.ctrlKey) && (code === 'KeyF' || (!code && key.toLowerCase() === 'f')) && !event.altKey) return 'search';
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  if (code === 'Enter' || code === 'NumpadEnter' || (!code && key === 'Enter')) return 'chat';
  const digit = code?.match(/^(?:Digit|Numpad)([1-9])$/)?.[1] ?? (!code && /^[1-9]$/.test(key) ? key : null);
  if (digit) {
    const index = Number(digit) - 1;
    return index < weaponCount ? { type: 'weapon', index } : null;
  }
  const viewKey = code?.startsWith('Key') ? code.slice(3).toLowerCase() : (!code ? key.toLowerCase() : '');
  switch (viewKey) {
    case 'r': return 'report';
    case 'm': return 'map';
    case 'g': return 'globe';
    default: return null;
  }
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}
