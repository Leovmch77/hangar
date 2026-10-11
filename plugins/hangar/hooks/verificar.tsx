import { atom, read, update } from "claude-code";
import type { EngineInterface, Hook, On } from "claude-code";

import type { BackgroundShell, VerificarBoard, VerificarRun, VerificarStep } from "../types";
import { formatDuration, parseNotifications, parseRun } from "./verificarParse";

// Andamento do scripts/verificar-local e dos comandos em segundo plano: faixa acima do prompt e o
// painel do /andamento. Lê os arquivos que o script grava; não fala com o backend.
export const VERIFICAR_PANE = "hangar-andamento";
const TICK_MS = 3000;
const KEEP_RUN_MS = 10 * 60_000;
const KEEP_SHELL_MS = 60_000;
const FORGET_SHELL_MS = 24 * 3600_000;

const board = atom({ plugin: "hangar", key: "verificarBoard" } as const, { now: 0, runs: [] } as VerificarBoard);
const shells = atom({ plugin: "hangar", key: "backgroundShells" } as const, [] as BackgroundShell[]);

async function stateDir($: EngineInterface): Promise<string> {
  const xdg = await $.env.get("XDG_STATE_HOME");
  const home = await $.env.get("HOME");
  return `${xdg || `${home}/.local/state`}/hangar-verificacao`;
}

async function tail($: EngineInterface, path: string): Promise<string[]> {
  const r = await $.process.run(["tail", "-n", "6", path], { timeoutMs: 5000 }).catch(() => undefined);
  return r && r.exitCode === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

async function scanRuns($: EngineInterface, now: number): Promise<VerificarRun[]> {
  const dir = await stateDir($);
  const entries = await $.fs.list(`${dir}/andamento`).catch(() => []);
  const runs: VerificarRun[] = [];
  for (const f of entries) {
    if (f.kind !== "file" || now - f.mtimeMs > 24 * 3600_000) continue;
    const parsed = parseRun(f.name, await $.fs.read(`${dir}/andamento/${f.name}`).catch(() => ""));
    if (!parsed) continue;
    const pid = f.name.split("-").pop() ?? "";
    const isAlive = parsed.rc === undefined && (await $.fs.exists(`/proc/${pid}`));
    if (!isAlive && now - (parsed.endedAt ?? f.mtimeMs) > KEEP_RUN_MS) continue;
    const run: VerificarRun = { ...parsed, isAlive };
    if (isAlive) {
      for (const s of run.steps) {
        if (s.state === "rodando" && s.so === "linux") {
          s.tail = await tail($, `${dir}/logs/${run.sha}-linux-${s.name}.log`);
        }
      }
      if (run.steps.some((s) => s.so === "windows" && s.state !== "ok")) {
        run.windowsTail = await tail($, `${dir}/logs/${run.sha}-windows.log`);
      }
    }
    runs.push(run);
  }
  return runs.sort((a, b) => a.startedAt - b.startedAt);
}

function liveShells(list: BackgroundShell[], now: number): BackgroundShell[] {
  return list.filter((s) => s.endedAt === undefined || now - s.endedAt < KEEP_SHELL_MS);
}

function runVerdict(run: VerificarRun): { text: string; tone: "ok" | "bad" | "dim" } {
  if (run.isAlive) return { text: run.isQueued ? "na fila (outra verificação nesta máquina)" : "rodando", tone: "dim" };
  // Rodada cancelada pode gravar "fim 0" com passos que nunca terminaram ou nem começaram; o plano
  // gravado já traz só os passos que faltam, então "fim 0" com pendente não é sucesso.
  if (
    run.rc === undefined ||
    run.steps.some((s) => s.state === "rodando") ||
    (run.rc === 0 && run.steps.some((s) => s.state === "pendente"))
  ) {
    return { text: "interrompida", tone: "bad" };
  }
  return run.rc === 0 ? { text: "ok", tone: "ok" } : { text: "FALHOU", tone: "bad" };
}

function stepLabel(s: VerificarStep, now: number): string {
  if (s.state === "rodando") return `${s.name} ${formatDuration(now - (s.startedAt ?? now))}`;
  if (s.state === "ok" || s.state === "falhou") return `${s.name} ${formatDuration((s.seconds ?? 0) * 1000)}`;
  return s.name;
}

let isBusy = false;

async function tick($: EngineInterface) {
  if (isBusy) return;
  isBusy = true;
  try {
    const now = await $.clock.now();
    const runs = await scanRuns($, now);
    const prev = await read($, board);
    const list = await read($, shells);
    // Sem nada para mostrar agora nem no último desenho, não redesenha a cada tique. O desenho filtra
    // os shells pelo `now` gravado: sem gravar o novo, um shell vencido ficaria na faixa.
    if (runs.length === 0 && prev.runs.length === 0 && liveShells(list, now).length === 0 && liveShells(list, prev.now).length === 0) return;
    await update($, board, () => ({ now, runs }));
    await update($, shells, (list) => list.filter((s) => now - s.startedAt < FORGET_SHELL_MS));
  } finally {
    isBusy = false;
  }
}

const start: Hook<"session.start"> = async ($, e, next) => {
  await $.command.register({
    name: "andamento",
    description: "Mostra o verificar-local e os comandos em segundo plano com o fim dos logs",
  });
  $.clock.every(TICK_MS, () => tick($));
  void tick($);
  return next(e);
};

export function registerVerificar(on: On) {
  // Com matcher: o state.ts tem o único `session.start` sem matcher. As duas metades cobrem toda sessão.
  on("session.start", { isInteractive: true }, start);
  on("session.start", { isInteractive: false }, start);

  on("command.run", { command: "andamento" }, async ($) => {
    await $.ui.open({ id: VERIFICAR_PANE, title: "Andamento" });
    return { text: "Painel de andamento aberto." };
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const ran = await next(e);
    const id = ran.deny === undefined && !ran.isError ? ran.result.backgroundTaskId : undefined;
    if (id) {
      const now = await $.clock.now();
      await update($, shells, (list) => [...list.filter((s) => s.id !== id), { id, command: e.command, startedAt: now }]);
      void tick($);
    }
    return ran;
  });

  on("tool.call", { tool: "TaskStop" }, async ($, e, next) => {
    const ran = await next(e);
    const id = ran.deny === undefined && !ran.isError ? ran.result.task_id : undefined;
    if (id) {
      const now = await $.clock.now();
      await update($, shells, (list) => list.map((s) => (s.id === id ? { ...s, endedAt: now, status: "killed" } : s)));
    }
    return ran;
  });

  on("prompt.submit", { origin: { kind: "task-notification" } }, async ($, e, next) => {
    const done = parseNotifications(e.text);
    if (done.length > 0) {
      const now = await $.clock.now();
      await update($, shells, (list) =>
        list.map((s) => {
          const d = done.find((x) => x.id === s.id);
          return d ? { ...s, endedAt: now, status: d.status } : s;
        }),
      );
    }
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const { now, runs } = await read($, board);
    const sh = liveShells(await read($, shells), now);
    if (runs.length === 0 && sh.length === 0) return next(e);
    const { Box, Text } = $.ui.resolve(e);

    return (
      <Box flexDirection="column">
        {runs.map((run) => {
          const verdict = runVerdict(run);
          const byOs = ["linux", "windows"]
            .map((so) => {
              const steps = run.steps.filter((s) => s.so === so);
              if (steps.length === 0) return "";
              const done = steps.filter((s) => s.state === "ok").length;
              const busy = steps.filter((s) => s.state === "rodando").map((s) => stepLabel(s, now));
              const failed = steps.filter((s) => s.state === "falhou").map((s) => s.name);
              return [
                `${so} ${done}/${steps.length}`,
                busy.length ? `rodando ${busy.join(", ")}` : "",
                failed.length ? `✗ ${failed.join(", ")}` : "",
              ]
                .filter(Boolean)
                .join(" ");
            })
            .filter(Boolean);
          return (
            <Box key={run.id}>
              <Text>
                verificar {run.sha}{" "}
                <Text color={verdict.tone === "ok" ? "green" : verdict.tone === "bad" ? "red" : undefined} dimColor={verdict.tone === "dim"}>
                  {verdict.text}
                </Text>
                <Text dimColor>
                  {" · "}
                  {byOs.join(" · ")}
                  {run.isAlive ? ` · ${formatDuration(now - run.startedAt)}` : ""}
                </Text>
              </Text>
            </Box>
          );
        })}
        {sh.slice(0, 3).map((s) => (
          <Box key={s.id}>
            <Text dimColor>
              bg {s.endedAt === undefined ? formatDuration(now - s.startedAt) : s.status ?? "fim"} · {s.command.split("\n")[0]?.slice(0, 70)}
            </Text>
          </Box>
        ))}
        {sh.length > 3 && <Text dimColor>+{sh.length - 3} em segundo plano · /andamento</Text>}
      </Box>
    );
  });

  on("ui.render", { component: "Pane", requestId: VERIFICAR_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const { now, runs } = await read($, board);
    const sh = liveShells(await read($, shells), now);

    return (
      <Box flexDirection="column">
        {runs.length === 0 && sh.length === 0 && <Text dimColor>Nada rodando em segundo plano.</Text>}
        {runs.map((run) => (
          <Box key={run.id} flexDirection="column" marginBottom={1}>
            <Text bold>
              verificar-local {run.sha} · {runVerdict(run).text}
              {run.vm ? ` · VM ${run.vm}` : ""}
            </Text>
            {run.steps.map((s) => (
              <Box key={`${s.so}-${s.name}`} flexDirection="column">
                <Text color={s.state === "ok" ? "green" : s.state === "falhou" ? "red" : undefined} dimColor={s.state === "pendente"}>
                  {"  "}
                  {s.state === "ok" ? "✓" : s.state === "falhou" ? "✗" : s.state === "rodando" ? "…" : "·"} {s.so}/{stepLabel(s, now)}
                </Text>
                {(s.tail ?? []).map((l, i) => (
                  <Text key={`t${i}`} dimColor>
                    {"      "}
                    {l.slice(0, 160)}
                  </Text>
                ))}
              </Box>
            ))}
            {(run.windowsTail ?? []).map((l, i) => (
              <Text key={`w${i}`} dimColor>
                {"      windows: "}
                {l.slice(0, 150)}
              </Text>
            ))}
          </Box>
        ))}
        {sh.map((s) => (
          <Text key={s.id} dimColor={s.endedAt !== undefined}>
            bg {s.id} · {s.endedAt === undefined ? `rodando ${formatDuration(now - s.startedAt)}` : s.status ?? "fim"} · {s.command.slice(0, 200)}
          </Text>
        ))}
      </Box>
    );
  });
}
