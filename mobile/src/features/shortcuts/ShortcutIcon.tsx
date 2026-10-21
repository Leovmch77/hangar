import { Text } from 'react-native';
import type { ShortcutInternalAction } from '@hangar/core';
import { Icon, type IconName } from '../../ui/Icon';
import * as m from '../../paraglide/messages';

export const NATIVE_LABEL: Record<ShortcutInternalAction, () => string> = {
  terminal: m.native_shortcuts_native_terminal,
  modo: m.native_shortcuts_native_modo,
  navegador: m.native_shortcuts_native_navegador,
  anexos: m.native_shortcuts_native_anexos,
  rodar: m.native_shortcuts_native_rodar,
  externo: m.native_shortcuts_native_externo,
};
export const NATIVE_ICON: Record<ShortcutInternalAction, string> = {
  terminal: 'glifo:terminal', modo: 'glifo:git', navegador: 'glifo:globe', anexos: 'glifo:folder', rodar: 'glifo:play',
  externo: 'glifo:terminal',
};
export const GLYPHS: [string, IconName][] = [
  ['bolt', 'Zap'], ['play', 'Play'], ['rocket', 'Rocket'], ['gear', 'Settings'], ['git', 'GitBranch'],
  ['chat', 'MessageCircle'], ['star', 'Star'], ['folder', 'Folder'], ['key', 'Key'], ['terminal', 'SquareTerminal'],
  ['globe', 'Globe'], ['robot', 'Bot'],
];

export function glyphIcon(name: string): IconName {
  return GLYPHS.find(([g]) => g === name)?.[1] ?? 'Zap';
}

export function ShortcutIcon({ icon, size, color }: { icon?: string; size: number; color: string }) {
  const emoji = icon?.startsWith('emoji:') ? icon.slice(6).trim() : '';
  if (emoji) return <Text style={{ fontSize: size, lineHeight: size + 4 }}>{emoji}</Text>;
  return <Icon name={glyphIcon(icon?.startsWith('glifo:') ? icon.slice(6) : 'bolt')} size={size} color={color} />;
}
