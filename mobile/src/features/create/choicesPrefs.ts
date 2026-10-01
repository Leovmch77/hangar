import type { Provider } from '@hangar/core';
import { prefs } from '../../stores/prefs';

// Últimas escolhas da Nova conversa, por máquina: contas e modelos são de cada servidor.
export type NewChatChoices = {
  provider?: Provider;
  model?: string;
  effort?: string;
  headless?: boolean;
  configDir?: string;
  codexAccount?: string;
};

const key = (serverId: string) => `create.choices.v1:${serverId}`;
const MACHINE = 'create.machine.v1';

export function readChoices(serverId: string): NewChatChoices {
  const raw = prefs.getString(key(serverId));
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? value as NewChatChoices : {};
  } catch {
    return {};
  }
}

export function rememberChoices(serverId: string, patch: NewChatChoices): void {
  try { prefs.set(key(serverId), JSON.stringify({ ...readChoices(serverId), ...patch })); }
  catch { /* escolha só não volta na próxima abertura */ }
}

// A máquina da Nova conversa não é o servidor ativo do app: trocar aqui não mexe nas Configurações.
export const readMachine = () => prefs.getString(MACHINE) ?? null;
export function rememberMachine(serverId: string): void {
  try { prefs.set(MACHINE, serverId); } catch { /* idem */ }
}
