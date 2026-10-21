import type { Shortcut, ShortcutInternalAction } from '@hangar/core';

export const PANEL_INTERNAL: ShortcutInternalAction[] = ['terminal', 'anexos'];

export function panelShortcuts(list: Shortcut[]): Shortcut[] {
  return list.filter((shortcut) => shortcut.type === 'send_text'
    || (shortcut.type === 'internal' && PANEL_INTERNAL.includes(shortcut.action)));
}
