import type { CommandInfo } from './types';

// Sugestões enquanto a pessoa digita `/nome`: prefixo vence substring, no máximo `max`.
// `query` é o que veio depois da barra; null = o campo não é um comando sendo digitado.
export function slashMatches(commands: CommandInfo[], query: string | null, max = 8): CommandInfo[] {
  if (query === null) return [];
  const token = query.toLowerCase();
  return commands
    .map((c) => {
      const n = c.name.toLowerCase();
      return { c, r: !token ? 1 : n.startsWith(token) ? 0 : n.includes(token) ? 1 : -1 };
    })
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .slice(0, max)
    .map((x) => x.c);
}

// `/btw <pergunta>` abre a pergunta lateral em vez de virar mensagem. Devolve a pergunta (pode ser
// vazia) ou null quando o texto não é esse comando.
export function sideQuestionOf(text: string): string | null {
  const btw = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return btw ? (btw[1] ?? '').trim() : null;
}
