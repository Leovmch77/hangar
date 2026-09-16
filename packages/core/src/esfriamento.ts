// Esfriamento por servidor: máquina que não responde para de ser procurada por um tempo, e volta
// a ser tentada sozinha quando esse tempo vence.
//
// O que existia antes eram duas coisas incompletas: o backoff do stream de lista (só o SSE, teto de
// 60s) e o `enabled: false` do peers.json, que é interruptor MANUAL — a máquina sumia do painel e
// só voltava quando alguém editava o arquivo. Medido em 16/09/2026 com um PC desligado há um dia:
// 87 tentativas em 15 min, uma a cada 10s, todas pendurando até o prazo porque VPN pra nó morto não
// recusa conexão, ela engole.
//
// A regra é sempre tentar de novo — só mais devagar. Nada aqui desiste de uma máquina: o teto é
// espera longa, nunca "nunca mais". E quem está olhando a tela fura a espera pelo `retentarAgora`.
//
// Falha de REDE conta (não chegou a haver resposta). Um 500 ou um 401 não: o servidor respondeu,
// está vivo, e o problema é outro — esfriá-lo esconderia justamente o erro que precisa aparecer.

const FALHAS_PARA_ESFRIAR = 3;
// Esperas em ms, uma por rodada; a última vale para sempre daí em diante.
const ESPERAS = [60_000, 120_000, 300_000, 900_000];

type Estado = { falhas: number; rodada: number; ate: number };

const estados = new Map<string, Estado>();

function estado(id: string): Estado {
  let e = estados.get(id);
  if (!e) {
    e = { falhas: 0, rodada: 0, ate: 0 };
    estados.set(id, e);
  }
  return e;
}

/** Quanto falta (ms) para este servidor voltar a ser procurado; 0 = pode ir agora. */
export function esperaDe(id: string, agora = Date.now()): number {
  const e = estados.get(id);
  return e && e.ate > agora ? e.ate - agora : 0;
}

export function estaEsfriando(id: string, agora = Date.now()): boolean {
  return esperaDe(id, agora) > 0;
}

/** Falha de rede: sem resposta nenhuma. Na terceira seguida, começa a esfriar. */
export function registrarFalha(id: string, agora = Date.now()): void {
  const e = estado(id);
  e.falhas += 1;
  if (e.falhas < FALHAS_PARA_ESFRIAR) return;
  e.ate = agora + ESPERAS[Math.min(e.rodada, ESPERAS.length - 1)];
  e.rodada += 1;
}

/** Respondeu: zera tudo. Uma resposta boa apaga o histórico de falhas, não só a espera atual. */
export function registrarSucesso(id: string): void {
  estados.delete(id);
}

/** "Buscar agora": libera a espera sem apagar o histórico — se continuar morta, a próxima espera é
 *  a mesma de antes, e não recomeça do 60s a cada toque. */
export function retentarAgora(id?: string): void {
  if (id === undefined) {
    for (const e of estados.values()) e.ate = 0;
    return;
  }
  const e = estados.get(id);
  if (e) e.ate = 0;
}

export function _limparEsfriamentoParaTestes(): void {
  estados.clear();
}
