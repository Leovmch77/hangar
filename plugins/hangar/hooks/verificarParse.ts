import type { VerificarRun, VerificarStep } from "../types";

export type ParsedRun = Omit<VerificarRun, "isAlive">;

// Formato gravado pelo scripts/verificar-local em <estado>/hangar-verificacao/andamento/<sha>-<pid>:
//   <epoch> plano <sha> linux=a,b windows=c vm=<host>
//   <epoch> fila
//   <epoch> >> linux: rust…
//   <epoch> << linux: rust 178s ok|FALHOU
//   <epoch> fim <rc>
export function parseRun(id: string, text: string): ParsedRun | undefined {
  let run: ParsedRun | undefined;
  for (const line of text.split("\n")) {
    const m = /^(\d+) (.*)$/.exec(line);
    if (!m) continue;
    const at = Number(m[1]) * 1000;
    const rest = m[2] ?? "";
    const plan = /^plano (\S+) linux=(\S*) windows=(\S*) vm=(\S*)$/.exec(rest);
    if (plan) {
      const steps = (so: string, list: string) =>
        list.split(",").filter(Boolean).map((name): VerificarStep => ({ so, name, state: "pendente" }));
      run = {
        id,
        sha: plan[1] ?? "",
        vm: plan[4] ?? "",
        startedAt: at,
        isQueued: false,
        steps: [...steps("linux", plan[2] ?? ""), ...steps("windows", plan[3] ?? "")],
      };
      continue;
    }
    if (!run) continue;
    if (rest === "fila") {
      run.isQueued = true;
      continue;
    }
    const end = /^fim (\d+)$/.exec(rest);
    if (end) {
      run.rc = Number(end[1]);
      run.endedAt = at;
      continue;
    }
    const step = /^(>>|<<) (\S+): (\S+?)…?(?: (\d+)s (ok|FALHOU))?(?: |$)/.exec(rest);
    if (!step) continue;
    run.isQueued = false;
    const [, dir, so = "", name = ""] = step;
    // ">> windows: rodando na VM …" só diz que a VM começou; não é passo.
    if (name === "rodando") continue;
    let s = run.steps.find((x) => x.so === so && x.name === name);
    if (!s) {
      s = { so, name, state: "pendente" };
      run.steps.push(s);
    }
    if (dir === ">>") {
      s.state = "rodando";
      s.startedAt = at;
    } else {
      s.state = step[5] === "ok" ? "ok" : "falhou";
      s.seconds = Number(step[4] ?? 0);
    }
  }
  return run;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

// Notificação de tarefa de fundo: <task-id>…</task-id> … <status>…</status>, uma ou mais.
export function parseNotifications(text: string): { id: string; status: string }[] {
  const out: { id: string; status: string }[] = [];
  // Uma notificação por vez: sem isto, uma sem <status> levaria o status da seguinte.
  for (const envelope of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const m = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/.exec(envelope[1] ?? "");
    if (!m) continue;
    out.push({ id: (m[1] ?? "").trim(), status: (m[2] ?? "").trim() });
  }
  return out;
}
