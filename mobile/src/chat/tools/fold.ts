import { toolGroupTitulo, type ChatEvent, type ItemConversa } from '@hangar/core';
import * as m from '../../paraglide/messages';

// Linha da lista do chat no layout do nativo: mensagem, ou um trecho de trabalho (raciocínios e
// chamadas seguidas) dobrado numa linha só.
export type ConversationRow =
  | { type: 'event'; id: string; ev: ChatEvent }
  | { type: 'fold'; id: string; parts: ChatEvent[] };

// Junta o que o agruparConversa separou (pensamento, chamada solta, grupo) quando vem em sequência:
// entre duas mensagens o nativo mostra UM resumo, não um bloco por tipo. A regra de quem entra no
// pensamento continua no core; aqui só muda o desenho. O id do trecho é o do primeiro item, então
// fica estável enquanto o trecho cresce na cauda durante o streaming.
export function foldConversation(items: ItemConversa[]): ConversationRow[] {
  const rows: ConversationRow[] = [];
  let open: { type: 'fold'; id: string; parts: ChatEvent[] } | null = null;
  for (const item of items) {
    if (item.type === 'event') {
      open = null;
      rows.push(item);
      continue;
    }
    const parts = item.type === 'tool' ? [item.ev] : item.type === 'group' ? item.tools : item.eventos;
    if (open) open.parts = [...open.parts, ...parts];
    else {
      open = { type: 'fold', id: `f-${item.id}`, parts };
      rows.push(open);
    }
  }
  return rows;
}

/** Chamadas do trecho, sem o carregador de ferramentas: "select:WebSearch" é encanamento, não ação. */
export function foldCalls(parts: ChatEvent[]): ChatEvent[] {
  return parts.filter((p) => p.kind === 'tool_use' && p.tool_name !== 'ToolSearch');
}

// Título do trecho como no nativo: o raciocínio primeiro, depois a contagem por família
// ("3 raciocínios · rodou 2 comandos"). O `description` do Bash não entra: ele vira título de grupo
// no core, mas aqui o resumo tem que contar o que houve.
export function foldTitle(parts: ChatEvent[]): string {
  const thoughts = parts.filter((p) => p.kind === 'thinking').length;
  const calls = foldCalls(parts);
  const thought = thoughts === 0 ? '' : thoughts === 1 ? m.native_thinking() : m.native_tree_thoughts({ n: thoughts });
  const counts = calls.length ? toolGroupTitulo(calls.map((c) => ({ tool_name: c.tool_name }))) : '';
  if (thought && counts) return `${thought} · ${counts.charAt(0).toLowerCase()}${counts.slice(1)}`;
  return thought || counts;
}

/** "1 falhou" / "N falharam"; vazio sem falha. */
export function failedLabel(n: number): string {
  return n === 0 ? '' : n === 1 ? m.native_tools_failed_1() : m.native_tools_failed({ n });
}

const FILE_TOOLS = new Set(['Read', 'NotebookRead', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Alvo da linha: nas ferramentas de arquivo só o nome do arquivo, que é o que cabe no celular. */
export function callTarget(name: string | null | undefined, summary: string): string {
  return name && FILE_TOOLS.has(name) ? summary.replace(/^.*\//, '') : summary;
}
