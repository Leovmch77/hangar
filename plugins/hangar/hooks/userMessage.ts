import type { On } from "claude-code";
import { compactUserRow, hasContextRef } from "./contextRefs";

// Cada linha é redesenhada a cada quadro: a leitura dos blocos fica guardada pelo texto da mensagem.
// Mensagem sem bloco nem entra, para não empurrar as que têm.
const CACHE_MAX = 64;
const rows = new Map<string, string | null>();

function compactRow(message: string): string | null {
  if (!hasContextRef(message)) return null;
  const hit = rows.get(message);
  if (hit !== undefined) return hit;
  const row = compactUserRow(message);
  if (rows.size >= CACHE_MAX) rows.delete(rows.keys().next().value!);
  rows.set(message, row);
  return row;
}

// A citação e o elemento vão inteiros no texto da mensagem (o transcript é a única fonte), e o bloco
// cru tomaria a conversa do terminal. A linha compacta mostra `> trecho` ou `Elemento: …` e o
// comentário; o Ctrl+O (`isExpanded`) mostra a mensagem como foi enviada. A reescrita muda só o
// desenho da linha: o que o modelo leu fica como está.
export function registerUserMessage(on: On): void {
  on("ui.render", { component: "UserMessage" }, ($, e, next) => {
    if (e.props.isExpanded) return next(e);
    const text = compactRow(e.props.text);
    if (text === null) return next(e);
    // Os campos somente leitura (`onScreen` incluído) e o `viewport` seguem como chegaram.
    return next({ ...e, props: { ...e.props, text } });
  });
}
