import { create } from 'zustand';
import { dictationCeilingMs, getConfig, getConfigForServer, patchConfig, patchConfigForServer, ehEstilo, registrarDiag } from '@hangar/core';
import type { EstiloDitado, Server } from '@hangar/core';
import * as m from '../../paraglide/messages';

const PADRAO: EstiloDitado = 'prosa';

interface DitadoEstiloState {
  valor: EstiloDitado;
  pronto: boolean;
  // A leitura falhou: o valor local não confirma a escolha salva no servidor.
  falhou: boolean;
  // Teto da gravação, lido na mesma consulta do estilo; até lá vale o padrão do core.
  ceilingMs: number;
  carregar: () => Promise<void>;
  revalidar: () => Promise<void>;
  refreshCeiling: () => Promise<void>;
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
    ceilingMs: dictationCeilingMs(undefined),

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
          set({ ceilingMs: dictationCeilingMs(cfg.campos) });
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

    // Relido a cada gravação: o teto pode ter mudado na tela de Voz, e a pílula não precisa piscar por isso.
    refreshCeiling: async () => {
      if (target === null) return;
      const server = target ? { ...target } : undefined;
      try {
        const cfg = await (server ? getConfigForServer(server) : getConfig());
        set({ ceilingMs: dictationCeilingMs(cfg.campos) });
      } catch (e) {
        // Sem leitura fica o último teto conhecido; o ditado não espera a config.
        registrarDiag({ evento: 'dictation.ceiling_stale', nivel: 'aviso', codigo: 'ceiling_refresh_failed',
          detalhe: e instanceof Error ? e.message : undefined });
      }
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
      set({ valor: PADRAO, pronto: false, falhou: false, ceilingMs: dictationCeilingMs(undefined) });
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
