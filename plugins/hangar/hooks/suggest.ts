import type { EngineInterface, On } from "claude-code";

// Mesmo motivo do state.ts: `$` não atravessa import, então a ponte é local.
let url: string | null = null;
let token: string | null = null;
let sessao: string | null = null;
let lido = false;

async function avisar($: EngineInterface, texto: string, mostrada: boolean) {
  if (!lido) {
    url = (await $.env.get("HANGAR_PLUGIN_URL")) ?? null;
    token = (await $.env.get("HANGAR_PLUGIN_TOKEN")) ?? null;
    sessao = (await $.env.get("CP_SESSION_NAME")) ?? null;
    lido = true;
  }
  if (!url || !token || !sessao) return;
  try {
    await $.http.fetch(`${url}/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessao, token, texto, mostrada }),
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
