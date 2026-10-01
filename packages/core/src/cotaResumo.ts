// Resumo de cota de UMA conta pra caber numa linha de seletor ("5h 42% · 7d 18%"). Shape mínimo
// do /api/cotas (backend/app/cotas.py, `CotaConta`): o front web tem o tipo completo em
// lib/contaEstado; o app nativo só precisa disto.
export interface JanelaCotaResumo {
  rotulo: string;
  pct: number;
  reset_ts?: number | null;
  por_modelo?: boolean;
}

export interface CotaContaResumo {
  id: string;
  estado: 'lida' | 'sem_credencial' | 'expirada' | 'indisponivel';
  janelas: JanelaCotaResumo[];
  /** Código do backend (`sessao-viva`, `renovacao-falhou`, …), nunca texto de tela. */
  motivo?: string | null;
}

/** Leitura parou porque a credencial não renovou: resolve abrindo uma sessão na conta. */
export function cotaParada(c: CotaContaResumo | undefined): boolean {
  return c?.motivo === 'renovacao-falhou';
}

/** A cota da conta Claude cujo config dir é `path` — a chave do /api/cotas é `claude:<path>`. */
export function cotaDaConta<T extends { id: string }>(cotas: T[], path: string): T | undefined {
  return cotas.find((c) => c.id === `claude:${path}`);
}

/** Rótulo da primeira janela da conta inteira em 100% ("7d"); null se nenhuma estourou. A janela de
 *  um modelo só não trava a conta, por isso fica de fora. */
export function janelaEsgotada(c: CotaContaResumo | undefined): string | null {
  if (!c || c.estado !== 'lida') return null;
  return c.janelas.find((j) => !j.por_modelo && typeof j.pct === 'number' && j.pct >= 100)?.rotulo ?? null;
}

/** Janela geral cheia e ainda não renovada (o `exhausted` do app de PC): reset já passado é leitura velha. */
function bloqueada(c: CotaContaResumo | undefined, now: number): boolean {
  if (!c || c.estado !== 'lida') return false;
  return c.janelas.some((j) => !j.por_modelo && typeof j.pct === 'number' && j.pct >= 100 && (j.reset_ts == null || j.reset_ts > now));
}

/** Para onde sair quando a conta Claude `atual` tem a janela geral esgotada: a de mais folga (100 menos a
 *  pior janela, a regra do `sugerir_claude` do backend) entre as lidas e não esgotadas; empate fica com a
 *  ativa. null quando a atual não está esgotada, não tem cota lida ou nenhuma outra serve. `now` em segundos. */
export function contaComFolga(
  atual: string | null | undefined,
  contas: { path: string; active?: boolean }[],
  cotas: CotaContaResumo[],
  now: number,
): string | null {
  if (!atual || !bloqueada(cotaDaConta(cotas, atual), now)) return null;
  let best: { folga: number; ativa: boolean; path: string } | null = null;
  for (const conta of contas) {
    const c = cotaDaConta(cotas, conta.path);
    const pcts = c?.estado === 'lida' ? c.janelas.map((j) => j.pct).filter((p) => typeof p === 'number' && isFinite(p)) : [];
    if (!pcts.length || bloqueada(c, now)) continue;
    const folga = 100 - Math.max(...pcts);
    const ativa = !!conta.active;
    if (!best || folga > best.folga || (folga === best.folga && ativa && !best.ativa)) best = { folga, ativa, path: conta.path };
  }
  return best?.path ?? null;
}

/** "5h 42% · 7d 18%"; string vazia sem leitura ou sem janela (quem chama decide o texto). */
export function resumoCota(c: CotaContaResumo | undefined): string {
  if (!c || c.estado !== 'lida') return '';
  return c.janelas
    .filter((j) => typeof j.pct === 'number' && isFinite(j.pct))
    .map((j) => `${j.rotulo} ${Math.round(j.pct)}%`)
    .join(' · ');
}
