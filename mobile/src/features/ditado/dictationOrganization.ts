import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { fetchDictationOrganization } from '@hangar/core';
import type { DictationOrganization, Server } from '@hangar/core';

// Modo de organização por servidor (chave = id; '' = o ativo). Desligado, o servidor devolve o cru
// em todo estilo: a tela esconde o seletor em vez de oferecer uma escolha que não faz nada.
interface State {
  byServer: Record<string, DictationOrganization>;
  load: (server: Server | null | undefined) => Promise<void>;
}

// Uma leitura por servidor de cada vez: duas soltas podiam terminar fora de ordem.
const pending = new Map<string, Promise<void>>();

export const useDictationOrganizationStore = create<State>((set, get) => ({
  byServer: {},
  // Relê sempre: o modo é trocado no app desktop. Falha de leitura não apaga um modo já conhecido.
  load: (server) => {
    if (server === null || server?.removed) return Promise.resolve();
    const key = server?.id ?? '';
    const running = pending.get(key);
    if (running) return running;
    const job = fetchDictationOrganization(server)
      .then((v) => {
        if (v !== 'unknown' || !(key in get().byServer)) set({ byServer: { ...get().byServer, [key]: v } });
      })
      .finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  },
}));

/** Lê o modo do servidor na montagem e quando ele muda; `reloadKey` verdadeiro força nova leitura. */
export function useDictationOrganization(server: Server | null | undefined, reloadKey?: unknown): DictationOrganization {
  const id = server?.id ?? '';
  const unavailable = server === null || !!server?.removed;
  const value = useDictationOrganizationStore((s) => s.byServer[id]) ?? 'unknown';
  // O objeto do servidor muda a cada atualização da lista; a leitura segue o id.
  const serverRef = useRef(server);
  serverRef.current = server;
  useEffect(() => {
    if (reloadKey === false) return;
    void useDictationOrganizationStore.getState().load(serverRef.current);
  }, [id, unavailable, reloadKey]);
  return unavailable ? 'unknown' : value;
}
