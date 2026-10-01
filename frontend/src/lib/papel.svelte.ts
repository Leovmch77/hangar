// Papel desta tela em cada servidor. Backend sem /api/me (versão antiga) responde 404 e conta como dono.
import { getMeForServer } from '@hangar/core';
import type { Server } from './auth';

const roles = $state<Record<string, 'owner' | 'guest'>>({});
const pending = new Set<string>();

export function papelDo(server: Server | null): 'owner' | 'guest' | null {
  if (!server) return null;
  const key = `${server.id}|${server.token}`;
  if (!(key in roles) && !pending.has(key)) {
    pending.add(key);
    getMeForServer(server)
      .then((me) => { roles[key] = me.role; })
      .catch((e: { status?: number }) => {
        // Só resposta HTTP define o papel; falha de rede não grava nada e a próxima leitura tenta de novo.
        if (e?.status === 404) roles[key] = 'owner';
      })
      .finally(() => pending.delete(key));
  }
  return roles[key] ?? null;
}
