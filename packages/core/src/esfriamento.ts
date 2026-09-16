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

type Estado = { falhas: number; rodada: number; ate: number; ultima: number; liberadoNaMao: boolean };

const estados = new Map<string, Estado>();

function estado(id: string): Estado {
  let e = estados.get(id);
  if (!e) {
    e = { falhas: 0, rodada: 0, ate: 0, ultima: 0, liberadoNaMao: false };
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
  if (e.liberadoNaMao) {
    // A tentativa que veio de um "buscar agora" repete a espera em vez de subir: quem toca no
    // botão três vezes numa máquina morta estaria se punindo com 15 min de espera.
    e.liberadoNaMao = false;
    e.ate = agora + e.ultima;
    return;
  }
  e.ultima = ESPERAS[Math.min(e.rodada, ESPERAS.length - 1)];
  e.ate = agora + e.ultima;
  e.rodada += 1;
}

/** Respondeu: zera tudo. Uma resposta boa apaga o histórico de falhas, não só a espera atual. */
export function registrarSucesso(id: string): void {
  estados.delete(id);
}

/** "Buscar agora": libera a espera sem apagar o histórico — continuando morta, a espera volta a ser
 *  a MESMA (não recomeça do primeiro minuto nem sobe de degrau por causa do toque). */
export function retentarAgora(id?: string): void {
  const alvos = id === undefined ? [...estados.values()]
                                 : [estados.get(id)].filter((e) => e !== undefined);
  for (const e of alvos) {
    e.ate = 0;
    e.liberadoNaMao = true;
  }
}

/** Servidor saiu da lista: some com o estado dele. Sem isto o mapa só cresce. */
export function esquecerServidor(id: string): void {
  estados.delete(id);
}

export function _limparEsfriamentoParaTestes(): void {
  estados.clear();
}
