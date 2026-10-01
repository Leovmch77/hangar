import { attentionFeed, type AggSession } from '@hangar/core';

// "Precisa de você": quem está aguardando resposta, de todos os servidores, mais antigo primeiro.
// Vira o primeiro grupo do painel, e quem entra nele sai do grupo de origem: a mesma sessão em
// dois lugares repetia a pergunta, e num grupo recolhido ela ficava escondida.
export function splitAttention(rows: AggSession[]): { attention: AggSession[]; rest: AggSession[] } {
  const attention = attentionFeed(rows);
  if (!attention.length) return { attention, rest: rows };
  const fora = new Set(attention);
  return { attention, rest: rows.filter((r) => !fora.has(r)) };
}
