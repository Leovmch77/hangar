import { useEffect } from 'react';
import { create } from 'zustand';
import { fetchDictationOrganization } from '@hangar/core';
import type { DictationOrganization, Server } from '@hangar/core';

// Modo de organização por servidor (chave = id; '' = o ativo). Desligado, o servidor devolve o cru
// em todo estilo: a tela esconde o seletor em vez de oferecer uma escolha que não faz nada.
interface State {
  byServer: Record<string, DictationOrganization>;
  load: (server: Server | null | undefined) => Promise<void>;
}

export const useDictationOrganizationStore = create<State>((set, get) => ({
  byServer: {},
  // Relê sempre: o modo é trocado no app desktop. Falha de leitura não apaga um modo já conhecido.
  load: async (server) => {
    const key = server?.id ?? '';
    const v = await fetchDictationOrganization(server);
    if (v !== 'unknown' || !(key in get().byServer)) set({ byServer: { ...get().byServer, [key]: v } });
  },
}));

/** Lê o modo do servidor na montagem e quando ele muda; `reloadKey` força nova leitura. */
export function useDictationOrganization(server: Server | null | undefined, reloadKey?: unknown): DictationOrganization {
  const value = useDictationOrganizationStore((s) => s.byServer[server?.id ?? '']) ?? 'unknown';
  useEffect(() => {
    void useDictationOrganizationStore.getState().load(server);
  }, [server, reloadKey]);
  return value;
}
