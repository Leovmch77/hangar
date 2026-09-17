import { fetchCotacao } from '@hangar/core';
import type { Cur } from './fmt';

// Moeda de TODO custo do app — painel de contexto, card do quadro, folha de uso e a tela de
// custos. Antes a escolha existia só dentro da tela de custos (`cp_costs_currency`), então a
// mesma sessão aparecia em real num lugar e em dólar no outro.
//
// A cotação vem do backend (cache de 1h lá; aqui, uma busca por hora). Sem cotação o `fmt`
// cai pro dólar sozinho: converter por uma taxa que não temos seria inventar o número.
const CHAVE = 'cp_moeda';
const ANTIGA = 'cp_costs_currency';   // onde a tela de custos guardava; migrada na primeira leitura
const UMA_HORA = 3600_000;

function inicial(): Cur {
  try {
    const v = localStorage.getItem(CHAVE) ?? localStorage.getItem(ANTIGA);
    return v === 'BRL' ? 'BRL' : 'USD';
  } catch {
    return 'USD';
  }
}

let cur = $state<Cur>(inicial());
let rate = $state<number | null>(null);
let buscadoEm = 0;
let emVoo: Promise<void> | null = null;

async function buscar(): Promise<void> {
  const agora = Date.now();
  if (buscadoEm && agora - buscadoEm < UMA_HORA) return;
  if (emVoo) return emVoo;
  buscadoEm = agora;   // conta a TENTATIVA: offline não paga o timeout a cada tela que abre
  emVoo = fetchCotacao()
    .then((v) => {
      // Falha mantém a última cotação conhecida em vez de apagar o que está na tela.
      if (v != null) rate = v;
    })
    .finally(() => {
      emVoo = null;
    });
  return emVoo;
}

export const moeda = {
  get cur() {
    return cur;
  },
  get rate() {
    return rate;
  },
  /** Já dá pra mostrar em real? Sem cotação o seletor fica travado em dólar. */
  get temCotacao() {
    return rate != null;
  },
  escolher(v: Cur): void {
    cur = v;
    try {
      localStorage.setItem(CHAVE, v);
    } catch {
      /* modo privado: vale só nesta aba */
    }
  },
  /** Chamado por quem vai MOSTRAR custo. Barato: no máximo uma ida por hora. */
  garantirCotacao(): void {
    void buscar();
  },
};
