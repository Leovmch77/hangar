// Arranjo dos blocos do desktop, à direita da barra lateral.
//
// A barra lateral NÃO entra: ela é o chrome do app, não um painel da sessão (mesma divisão do
// MonoCode, onde a árvore de split cobre só os painéis da aba e os cartões da barra são arrastados
// PARA dentro deles). Os três que se movem são os da sessão em foco: a coluna de git, a conversa e
// o painel de contexto.
//
// O arranjo é uma lista de COLUNAS, cada uma com um ou mais blocos empilhados de cima pra baixo.
// Duas colunas de um bloco e uma de dois é o "três na horizontal com um dividido em dois na
// vertical". Vira `grid-column`/`grid-row` no shell — nunca reagrupamento de DOM, senão a conversa
// trocaria de pai a cada arrasto e o Svelte a recriaria (SSE novo, histórico recarregado).

export type BlocoShell = 'git' | 'chat' | 'ctx';
/** Onde soltar em relação ao bloco de destino — as quatro bordas dele. */
export type BordaSolta = 'esquerda' | 'direita' | 'cima' | 'baixo';

export const BLOCOS: readonly BlocoShell[] = ['git', 'chat', 'ctx'];

/** O arranjo de sempre: git à esquerda da conversa, contexto à direita, um por coluna. */
export const ARRANJO_PADRAO: BlocoShell[][] = [['git'], ['chat'], ['ctx']];

const CHAVE = 'cp_shell_arranjo';

const copiar = (a: BlocoShell[][]): BlocoShell[][] => a.map((c) => [...c]);

function valida(bruto: unknown): BlocoShell[][] | null {
  if (!Array.isArray(bruto) || !bruto.length) return null;
  const colunas: BlocoShell[][] = [];
  for (const coluna of bruto) {
    if (!Array.isArray(coluna) || !coluna.length) return null;
    const blocos = coluna.filter((b): b is BlocoShell => BLOCOS.includes(b as BlocoShell));
    if (blocos.length !== coluna.length) return null;
    colunas.push(blocos);
  }
  // Os TRÊS, sem repetir: um bloco ausente ficaria sem célula no grid e não seria desenhado;
  // repetido, duas células disputariam o mesmo componente.
  const todos = colunas.flat();
  if (todos.length !== BLOCOS.length || new Set(todos).size !== BLOCOS.length) return null;
  return colunas;
}

function carregar(): BlocoShell[][] {
  // O try cobre SÓ a leitura e o parse (modo privado, valor corrompido). A `valida` fica de fora
  // de propósito: com ela dentro, um erro de programação nela seria indistinguível de "não tem
  // nada salvo" e o arranjo que a pessoa montou resetaria sozinho, calado.
  let bruto: unknown;
  try {
    bruto = JSON.parse(localStorage.getItem(CHAVE) ?? 'null');
  } catch {
    return copiar(ARRANJO_PADRAO);
  }
  return valida(bruto) ?? copiar(ARRANJO_PADRAO);
}

const estado = $state({ colunas: carregar() });

/** Onde um bloco está: em que coluna e em que linha dela. */
function achar(bloco: BlocoShell): { col: number; linha: number } | null {
  for (let col = 0; col < estado.colunas.length; col++) {
    const linha = estado.colunas[col].indexOf(bloco);
    if (linha >= 0) return { col, linha };
  }
  return null;
}

export const shellLayout = {
  get colunas() { return estado.colunas; },

  /** Coluna do bloco no grid (1-based). A barra lateral fica sempre na coluna 1. */
  coluna(bloco: BlocoShell): number {
    return (achar(bloco)?.col ?? 0) + 2;
  },
  /** Linha do bloco: `1 / -1` quando ele é o único da coluna, senão a linha dele. */
  linha(bloco: BlocoShell): string {
    const onde = achar(bloco);
    if (!onde) return '1 / -1';
    const altura = estado.colunas[onde.col].length;
    return altura === 1 ? '1 / -1' : `${onde.linha + 1} / ${onde.linha + 2}`;
  },
  /** Quantas linhas o grid precisa: a coluna mais alta manda. */
  get linhas(): number {
    return Math.max(...estado.colunas.map((c) => c.length));
  },
  /** O bloco divide a coluna com outro? Quem empilha perde a folga entre os dois. */
  empilhado(bloco: BlocoShell): boolean {
    const onde = achar(bloco);
    return !!onde && estado.colunas[onde.col].length > 1;
  },
  /** O bloco está na primeira coluna, encostado na barra lateral? */
  ehVizinhoDaSidebar(bloco: BlocoShell): boolean {
    return achar(bloco)?.col === 0;
  },
  /** O arranjo saiu do padrão? É o que decide se o botão de voltar ao normal existe. */
  get mexido(): boolean {
    return JSON.stringify(estado.colunas) !== JSON.stringify(ARRANJO_PADRAO);
  },

  definir(colunas: BlocoShell[][]): void {
    const bom = valida(colunas);
    if (!bom) return;
    estado.colunas = bom;
    try { localStorage.setItem(CHAVE, JSON.stringify(bom)); } catch { /* modo privado: vale pela sessão */ }
  },

  /**
   * Solta `bloco` numa das bordas de `alvo` — o gesto do arrasto.
   * Esquerda/direita: coluna nova antes/depois da do alvo. Cima/baixo: entra na MESMA coluna do
   * alvo, acima/abaixo dele. Soltar em si mesmo não faz nada.
   */
  soltar(bloco: BlocoShell, alvo: BlocoShell, borda: BordaSolta): void {
    if (bloco === alvo) return;
    const colunas = copiar(estado.colunas);
    // Tira o bloco de onde estava ANTES de mirar o alvo: a coluna dele pode desaparecer no
    // caminho, e os índices do alvo mudariam debaixo da conta.
    for (const c of colunas) {
      const i = c.indexOf(bloco);
      if (i >= 0) c.splice(i, 1);
    }
    const vazias = colunas.filter((c) => c.length);
    const destino = vazias.findIndex((c) => c.includes(alvo));
    if (destino < 0) return;

    if (borda === 'esquerda' || borda === 'direita') {
      vazias.splice(destino + (borda === 'direita' ? 1 : 0), 0, [bloco]);
    } else {
      const linha = vazias[destino].indexOf(alvo);
      vazias[destino].splice(linha + (borda === 'baixo' ? 1 : 0), 0, bloco);
    }
    shellLayout.definir(vazias);
  },

  restaurar(): void {
    shellLayout.definir(copiar(ARRANJO_PADRAO));
  },
};

/** Qual borda do retângulo o ponto está mirando — a régua do MonoCode (`paneEdgeFromPoint`). */
export function bordaDoPonto(x: number, y: number, r: DOMRect): BordaSolta {
  const nx = r.width <= 0 ? 0 : (x - r.left) / r.width - 0.5;
  const ny = r.height <= 0 ? 0 : (y - r.top) / r.height - 0.5;
  if (Math.abs(nx) > Math.abs(ny)) return nx < 0 ? 'esquerda' : 'direita';
  return ny < 0 ? 'cima' : 'baixo';
}
