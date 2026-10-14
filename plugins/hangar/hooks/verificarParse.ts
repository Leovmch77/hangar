import type { BackgroundShell, VerificarRun, VerificarStep } from "../types";

export type ParsedRun = Omit<VerificarRun, "isAlive">;

export type FdScan = Map<string, { pids: number[]; path: string }>;

// O Claude Code liga stdout/stderr de cada comando de fundo a <...>/tasks/<id>.output:
// processo segurando esse arquivo aberto = comando ainda vivo. Linhas de
// `find /proc/*/fd -lname '*/tasks/*.output' -printf '%h %l\n'`.
export function parseFdScan(text: string): FdScan {
  const out: FdScan = new Map();
  for (const line of text.split("\n")) {
    const m = /^\/proc\/(\d+)\/fd (.+\/tasks\/([^/]+)\.output)$/.exec(line.trim());
    if (!m) continue;
    const pid = Number(m[1]);
    const id = m[3] ?? "";
    const hit = out.get(id) ?? { pids: [], path: m[2] ?? "" };
    if (!hit.pids.includes(pid)) hit.pids.push(pid);
    out.set(id, hit);
  }
  return out;
}

// A notificação de fim pode nunca chegar (tarefa de subagente, sessão reaberta);
// sem processo segurando o arquivo, o comando acabou.
const BIRTH_GRACE_MS = 5000;

export function reconcileShells(list: BackgroundShell[], scan: FdScan, now: number): BackgroundShell[] {
  return list.map((s) => {
    if (s.endedAt !== undefined) return s;
    const hit = scan.get(s.id);
    if (hit) return { ...s, pids: hit.pids, path: hit.path };
    if (now - s.startedAt < BIRTH_GRACE_MS) return s;
    return { ...s, endedAt: now, status: s.status ?? "terminou" };
  });
}

// Saída de `ps -o pid=,args= -p <pids>`. O zsh que embrulha o comando (carrega o
// shell-snapshot) não diz nada; o filho de pid maior é o que roda agora.
// ponytail: pid maior = mais novo, erra só quando o contador de pids dá a volta.
export function currentCommands(psOut: string, scan: FdScan): Map<string, string> {
  const args = new Map<number, string>();
  for (const line of psOut.split("\n")) {
    const m = /^\s*(\d+) (.+)$/.exec(line);
    if (m && !m[2]?.includes("/shell-snapshots/")) args.set(Number(m[1]), m[2]?.trim() ?? "");
  }
  const out = new Map<string, string>();
  for (const [id, hit] of scan) {
    const pid = hit.pids.filter((p) => args.has(p)).sort((a, b) => b - a)[0];
    if (pid !== undefined) out.set(id, args.get(pid) ?? "");
  }
  return out;
}

export function lastLines(text: string, n: number): string[] {
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map((l) => (l.replace(/\r+$/, "").split("\r").pop() ?? "").trimEnd())
    .filter(Boolean)
    .slice(-n);
}

// Formato gravado pelo scripts/verificar-local em <estado>/hangar-verificacao/andamento/<sha>-<pid>:
//   <epoch> plano <sha> linux=a,b windows=c vm=<host>
//   <epoch> dono <sessão do Hangar que chamou>
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
    const owner = /^dono (.+)$/.exec(rest);
    if (owner) {
      run.owner = owner[1];
      continue;
    }
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
