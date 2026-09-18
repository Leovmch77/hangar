import type { EngineInterface, On } from "claude-code";

// A largada divide o `session.start` com o state.ts por MATCHER — dois hooks no
// mesmo evento sem matcher o engine recusa. O filtro não é enfeite: sem prompt
// box (`-p`, SDK) não há o que entregar.
const REARM_MS = 50;
// Sem o long-poll a espera cairia num `$.clock.sleep`, o único `$` que CONSOME
// o orçamento de 10 s do hook; a chamada HTTP em voo não consome nada.
const BACKOFF_MS = 2000;

type Ponte = { url: string; token: string; sessao: string };

/** Entrada sem `tmux send-keys` digitando: o backend segura a resposta até ter
 *  texto na fila e diz COMO entregar.
 *
 *  `fill` põe o rascunho no composer e o Hangar manda só o Enter — a mensagem
 *  chega como a fala do usuário. `submit` entrega inteiro por `$.prompt.submit`,
 *  sem tecla nenhuma, ao custo da moldura de "prompt de plugin". */
export function registerInput(on: On) {
  on("session.start", { isInteractive: true }, async ($, e, next) => {
    const url = await $.env.get("HANGAR_PLUGIN_URL");
    const token = await $.env.get("HANGAR_PLUGIN_TOKEN");
    // O nome da sessão no Hangar, carimbado no pane pelo `new_session`: é a
    // chave da fila lá, e não o uuid do transcript.
    const sessao = await $.env.get("CP_SESSION_NAME");
    if (url && token && sessao) {
      $.clock.after(REARM_MS, () => void pull($, { url, token, sessao }));
    }
    return next(e);
  });
}

async function pull($: EngineInterface, ponte: Ponte) {
  let espera = REARM_MS;
  try {
    const r = await $.http.fetch(`${ponte.url}/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessao: ponte.sessao, token: ponte.token }),
    });
    if (r.status === 200) {
      const { text, modo } = JSON.parse(r.text) as { text?: string | null; modo?: string };
      if (text && modo === "fill") {
        const { isFilled } = await $.prompt.fill({ text, mode: "replace" });
        await $.http.fetch(`${ponte.url}/filled`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessao: ponte.sessao, token: ponte.token, ok: isFilled }),
        });
      } else if (text) {
        await $.prompt.submit({ text });
      }
    } else {
      // 403 é token de outra vida da sessão: insistir de 50 ms bateria no
      // backend para sempre.
      espera = BACKOFF_MS;
    }
  } catch {
    espera = BACKOFF_MS;
  }
  $.clock.after(espera, () => void pull($, ponte));
}
