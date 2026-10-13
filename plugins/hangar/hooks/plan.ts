import type { EngineInterface, On } from "claude-code";
import { type Bridge as Ponte, bridge } from "./bridge";

const AVISO_MS = 1500;

/** Aprovação do plano (`ExitPlanMode`) no app, sem segurar nada.
 *
 *  O diálogo do terminal aparece sempre: `allow` no `tool.check` não o pula. O hook só entrega ao
 *  backend o texto do plano e devolve o veredito na hora; quem responde pelo app aperta as teclas
 *  do próprio diálogo, e o terminal continua respondendo como antes. */
export function registerPlan(on: On) {
  on("tool.check", { tool: "ExitPlanMode" }, async ($, e, next) => {
    const base = await next(e);
    const ponte = bridge();
    // Backend pendurado não pode atrasar o diálogo do terminal: o aviso tem prazo curto.
    // `allow` não pula o diálogo: só `deny` dispensa o aviso.
    if (base.decision !== "deny" && ponte && e.tool_use_id) {
      await Promise.race([notifyPlan($, ponte, e.tool_use_id, e.input), $.clock.sleep(AVISO_MS)]);
    }
    return base;
  });
}

/** Ponte fora do ar não tira o diálogo de ninguém: sem o aviso, o app mostra o problema. */
export async function notifyPlan($: Pick<EngineInterface, "http">, ponte: Ponte, toolUseId: string, input: unknown) {
  const i = (input ?? {}) as Record<string, unknown>;
  // Sem texto não há cartão a mostrar: o backend acusa a falta do aviso enquanto o diálogo estiver na tela.
  if (typeof i.plan !== "string" || !i.plan.trim()) return;
  try {
    await $.http.fetch(`${ponte.url}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessao: ponte.sessao, token: ponte.token, id: `plan:${toolUseId}`,
        plan: typeof i.plan === "string" ? i.plan : "",
        path: typeof i.planFilePath === "string" ? i.planFilePath : null,
      }),
    });
  } catch {
    // O backend registra a falta do aviso enquanto o diálogo estiver na tela.
  }
}
