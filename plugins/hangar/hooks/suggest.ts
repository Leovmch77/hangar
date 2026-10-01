import type { EngineInterface, On } from "claude-code";
import { bridge } from "./bridge";

// Mesmo motivo do state.ts: `$` não atravessa import, então o envio é local.
async function avisar($: EngineInterface, texto: string, mostrada: boolean) {
  const p = bridge();
  if (!p) return;
  try {
    await $.http.fetch(`${p.url}/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessao: p.sessao, token: p.token, texto, mostrada }),
    });
  } catch {
    // Backend fora do ar: perde-se a sugestão, não o resultado do hook.
  }
}

/** A frase cinza que a TUI propõe depois do turno (Tab aceita, no terminal).
 *
 * O matcher pega só a do ENGINE: `$.prompt.suggest` de um plugin passa por aqui
 * com origem `plugin`, e repassá-la seria o Hangar sugerindo a si mesmo. */
export function registerSuggest(on: On) {
  on("prompt.suggest", { origin: { kind: "suggestion" } }, async ($, e, next) => {
    const r = await next(e);
    await avisar($, e.text, r.isShown);
    return r;
  });
}
