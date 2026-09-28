// Terminais dos atalhos "shell", por sessao ("<servidor>::<nome>", a mesma chave do painel). O Chat
// precisa da contagem pro botao de terminal de sessao sem pane; o painel precisa da lista pras abas.
// Um estado so pros dois: a execucao no Chat e o fechar no painel mexem na mesma lista.
import { listShortcutTerminals, type ShortcutTerminal } from '@hangar/core';
import { listServers } from './auth';

export const shortcutTerminals = $state<{
  bySession: Record<string, ShortcutTerminal[]>;
  // Aba que o painel deve mostrar ao abrir (ou ja aberto): o terminal do atalho recem-clicado.
  focus: Record<string, string>;
}>({ bySession: {}, focus: {} });

export function shortcutTerminalsOf(key: string): ShortcutTerminal[] {
  return shortcutTerminals.bySession[key] ?? [];
}

// Relê do servidor dono da sessao. Falha deixa a lista anterior: o botao nao pode sumir por um
// GET perdido com o terminal ainda vivo la.
export async function refreshShortcutTerminals(key: string): Promise<ShortcutTerminal[]> {
  const [serverId, ...rest] = key.split('::');
  const name = rest.join('::');
  const srv = listServers().find((s) => s.id === serverId);
  if (!srv || !name) return shortcutTerminalsOf(key);
  const list = await listShortcutTerminals(srv, name);
  shortcutTerminals.bySession[key] = list;
  return list;
}

export function focusShortcutTerminal(key: string, id: string) {
  shortcutTerminals.focus[key] = id;
}

export function takeShortcutFocus(key: string): string | null {
  const id = shortcutTerminals.focus[key] ?? null;
  if (id) delete shortcutTerminals.focus[key];
  return id;
}
