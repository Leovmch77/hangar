import { create } from 'zustand';
import { getConfig, getConfigForServer, patchConfig, patchConfigForServer, ehEstilo } from '@hangar/core';
import type { EstiloDitado, Server } from '@hangar/core';
import * as m from '../../paraglide/messages';

const PADRAO: EstiloDitado = 'prosa';

interface DitadoEstiloState {
  valor: EstiloDitado;
  pronto: boolean;
  // A leitura falhou: o valor local não confirma a escolha salva no servidor.
  falhou: boolean;
  carregar: () => Promise<void>;
  revalidar: () => Promise<void>;
  trocar: (novo: EstiloDitado) => Promise<void>;
  _zerarParaTeste: () => void;
}

function createDictationStyleStore(server?: Server | null) {
  let target = server;
  let escritas = 0;
  let carregando: Promise<void> | null = null;

  const store = create<DitadoEstiloState>((set, get) => ({
    valor: PADRAO,
    pronto: false,
    falhou: false,

    carregar: async () => {
      if (!get().pronto) return get().revalidar();
    },

    revalidar: async () => {
      if (target === null) return;
      if (carregando) return carregando;
      const server = target ? { ...target } : undefined;
      const escritasNoInicio = escritas;
      set({ falhou: false });
      carregando = (server ? getConfigForServer(server) : getConfig())
        .then((cfg) => {
          const v = cfg.campos?.ditado_estilo?.valor;
          if (escritas === escritasNoInicio) set({ valor: ehEstilo(v) ? v : PADRAO, pronto: true, falhou: false });
        })
        .catch(() => {
          if (escritas === escritasNoInicio) set({ pronto: false, falhou: true });
        })
        .finally(() => {
          carregando = null;
        });
      return carregando;
    },

    trocar: async (novo: EstiloDitado) => {
      if (target === null) throw new Error(m.chat_servidor_removido());
      const server = target ? { ...target } : undefined;
      const antes = get().valor;
      const wasReady = get().pronto;
      const minha = ++escritas;
      set({ valor: novo });
      try {
        await (server ? patchConfigForServer(server, { ditado_estilo: novo }) : patchConfig({ ditado_estilo: novo }));
        set({ pronto: true, falhou: false });
      } catch (e) {
        if (escritas === minha) {
          set({ valor: antes, pronto: wasReady, falhou: !wasReady });
        }
        throw e;
      }
    },

    _zerarParaTeste: () => {
      escritas = 0;
      carregando = null;
      set({ valor: PADRAO, pronto: false, falhou: false });
    },
  }));

  return { store, updateServer: (server: Server) => { target = server; } };
}

export const useDitadoEstiloStore = createDictationStyleStore().store;
const unavailable = createDictationStyleStore(null).store;
const stores = new Map<string, ReturnType<typeof createDictationStyleStore>>();

export function dictationStyleStore(server?: Server | null) {
  if (server === undefined) return useDitadoEstiloStore;
  if (server === null || server.removed) return unavailable;
  let entry = stores.get(server.id);
  if (!entry) {
    entry = createDictationStyleStore(server);
    stores.set(server.id, entry);
  } else {
    entry.updateServer(server);
  }
  return entry.store;
}
