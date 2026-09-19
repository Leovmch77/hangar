// Estado do arrasto de uma sessão sobre outra (gesto de "trabalhar juntas") + o pedido de
// confirmação que ele abre. Compartilhado pelas quatro superfícies que arrastam sessão
// (Sidebar/Board/Canvas/celular, Task 3+) e consumido pelo GrupoDropDialog, montado UMA vez no
// shell (App.svelte) — quatro cópias do mesmo diálogo seriam quatro cópias do mesmo estado.
//
// Só CHAVES aqui, nunca o objeto AggSession capturado no clique: o diálogo relê a sessão do
// sessionsStore a cada render, senão confirma dado velho quando o SSE muda o grupo (ou a sessão
// morre) durante a confirmação.
import type { DropReason } from '@hangar/core';
import * as m from '../paraglide/messages';

export interface ChaveSessao { serverId: string; name: string }
export type ModoPedidoGrupo = 'agrupar' | 'sair';
export interface PedidoGrupo {
  modo: ModoPedidoGrupo;
  origem: ChaveSessao;
  alvo?: ChaveSessao; // só no modo 'agrupar'
}

function partirChave(chave: string): ChaveSessao | null {
  const i = chave.indexOf('::');
  return i < 0 ? null : { serverId: chave.slice(0, i), name: chave.slice(i + 2) };
}

function createArrastarGrupo() {
  let origem = $state<ChaveSessao | null>(null);
  // Chave (serverId::name) do alvo sob o ponteiro DURANTE o arrasto — só para destacar o card;
  // quem decide a validade é canPair, chamado pela tela que desenha o destaque (Task 3+).
  let alvo = $state<string | null>(null);
  let pedido = $state<PedidoGrupo | null>(null);

  return {
    get origem() { return origem; },
    get alvo() { return alvo; },
    get pedido() { return pedido; },

    /** Início do arrasto: guarda quem está sendo arrastada. */
    comecar(s: ChaveSessao) { origem = s; alvo = null; },
    /** Ponteiro entrou sobre um alvo possível. */
    entrarEm(chave: string) { alvo = chave; },
    /** Ponteiro saiu do alvo (só desfaz se ainda for o mesmo — outro entrarEm já pode ter assumido). */
    sairDe(chave: string) { if (alvo === chave) alvo = null; },
    /** Soltou a origem sobre `alvoChave` (serverId::name): fecha o arrasto e abre a confirmação. */
    soltar(alvoChave: string) {
      const destino = origem ? partirChave(alvoChave) : null;
      if (origem && destino) pedido = { modo: 'agrupar', origem, alvo: destino };
      origem = null;
      alvo = null;
    },
    /** Pedido de saída não nasce de arrasto: é o clique direto num botão "sair do grupo". */
    pedirSaida(s: ChaveSessao) { pedido = { modo: 'sair', origem: s }; },
    /** Cancela o arrasto em curso e/ou fecha o diálogo pendente. */
    cancelar() { origem = null; alvo = null; pedido = null; },
  };
}

export const arrastarGrupo = createArrastarGrupo();

// Frase de tela por motivo de recusa do canPair — usada pelo GrupoDropDialog (recheca contra o
// sessionsStore antes de confirmar) e pelas telas de arrasto (Task 3+, destaque do alvo inválido).
export function mensagemRecusa(reason: DropReason): string {
  switch (reason) {
    case 'same': return m.grupo_recusa_same();
    case 'dead': return m.grupo_recusa_dead();
    case 'same_group': return m.grupo_recusa_same_group();
    case 'other_server': return m.grupo_recusa_other_server();
    case 'cross_server': return m.grupo_recusa_cross_server();
  }
}
