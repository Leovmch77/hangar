// Terminais de atalho vivos, por servidor, do evento `shortcut_terminals` do stream da lista (nunca
// um SSE próprio). O chip, os tiles, o painel de terminal e o cartão da pergunta leem daqui.
// `serverId` é o `Server.id` (auth.ts), o mesmo do `sessionsStore`.
import type { LiveShortcutTerminal } from '@hangar/core';

export type TileState = 'idle' | 'running' | 'asking' | 'exited';

export const liveTerminals = $state<{
  byServer: Record<string, LiveShortcutTerminal[]>;
  // Cartão da pergunta aberto: `owner` vazio = No Hangar.
  question: { serverId: string; owner: string; id: string } | null;
  // Aba No Hangar que o painel de terminal deve mostrar ao abrir.
  panelRequest: Record<string, string>;
}>({ byServer: {}, question: null, panelRequest: {} });

// O backend grava a chave com o espaço colapsado; comparar do mesmo jeito.
const normKey = (key: string) => key.split(/\s+/).filter(Boolean).join(' ');

export function setLiveTerminals(serverId: string, raw: string) {
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error('shortcut_terminals frame must be an array');
    liveTerminals.byServer[serverId] = list;
  } catch (err) {
    console.error('shortcut_terminals:', err);
  }
}

/** Servidor removido ou com o stream da lista caído: o chip não pode mostrar terminal velho dele. */
export function forgetServer(serverId: string) {
  delete liveTerminals.byServer[serverId];
}

export function hangarOf(serverId: string): LiveShortcutTerminal[] {
  return (liveTerminals.byServer[serverId] ?? []).filter((t) => t.owner === '');
}
export function hangarForShortcut(serverId: string, key: string): LiveShortcutTerminal | null {
  const k = normKey(key);
  return hangarOf(serverId).find((t) => normKey(t.key) === k) ?? null;
}
/** Terminal mais novo do atalho `key` na sessão (é o que o tile daquele atalho representa). */
export function sessionTerminalFor(serverId: string, session: string, key: string): LiveShortcutTerminal | null {
  const k = normKey(key);
  return (liveTerminals.byServer[serverId] ?? []).filter((t) => t.owner === session && normKey(t.key) === k).at(-1) ?? null;
}
export function allHangar(): { serverId: string; t: LiveShortcutTerminal }[] {
  return Object.keys(liveTerminals.byServer).flatMap((serverId) => hangarOf(serverId).map((t) => ({ serverId, t })));
}
export function tileStateOf(t: LiveShortcutTerminal | null): TileState {
  if (!t) return 'idle';
  if (!t.alive) return 'exited';
  return t.question ? 'asking' : 'running';
}
/** `created` em segundos (do multiplexador), `nowMs` em milissegundos. Nunca "0 min". */
export function runningFor(created: number, nowMs: number): { minutes: number } | { hours: number } {
  const minutes = Math.max(1, Math.floor((nowMs / 1000 - created) / 60));
  return minutes < 60 ? { minutes } : { hours: Math.floor(minutes / 60) };
}
export function openQuestion(serverId: string, owner: string, id: string) {
  liveTerminals.question = { serverId, owner, id };
}
export function closeQuestion() { liveTerminals.question = null; }
export function requestHangarTab(serverId: string, id: string) { liveTerminals.panelRequest[serverId] = id; }
export function takeHangarTab(serverId: string): string | null {
  const id = liveTerminals.panelRequest[serverId] ?? null;
  if (id) delete liveTerminals.panelRequest[serverId];
  return id;
}
