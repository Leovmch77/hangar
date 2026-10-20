import type { AccountHolders } from '@hangar/core';
import * as m from '../paraglide/messages';

/** Linhas da confirmação de liberar a conta: sessões que trocam de conta e processos encerrados. */
export function releaseLines(h: AccountHolders): string[] {
  const linhas: string[] = [];
  if (h.sessoes.length) linhas.push(m.contas_liberar_sessoes({ lista: h.sessoes.join(', ') }));
  if (h.processos.length) {
    const lista = h.processos.map((p) => m.contas_liberar_processo({
      nome: p.sessao ? m.contas_liberar_processo_terminal({ sessao: p.sessao }) : p.nome ?? '?',
      pid: p.pid,
    })).join(', ');
    linhas.push(m.contas_liberar_processos({ lista }));
  }
  return linhas;
}
