import { expect, test } from "claude-code/testing";

import { currentCommands, lastLines, parseFdScan, parseNotifications, parseRun, reconcileShells } from "./verificarParse";

test("lê o andamento gravado pelo verificar-local", () => {
  const run = parseRun(
    "890a0cdf9b-4242",
    [
      "100 plano 890a0cdf9b linux=rust,backend windows=rust vm=delphi-02",
      "101 fila",
      "200 >> linux: preparo…",
      "260 << linux: preparo 60s ok",
      "261 >> windows: rodando na VM delphi-02 (log: /x/890a0cdf9b-windows.log)",
      "262 >> linux: rust…",
      "263 >> linux: backend…",
      "300 << linux: rust 38s FALHOU",
      "301 >> windows: rust…",
    ].join("\n"),
  );
  expect(run?.isQueued).toBe(false);
  expect(run?.rc).toBe(undefined);
  expect(run?.steps.map((s) => `${s.so}/${s.name}:${s.state}`)).toEqual([
    "linux/rust:falhou",
    "linux/backend:rodando",
    "windows/rust:rodando",
    "linux/preparo:ok",
  ]);
  expect(run?.steps.find((s) => s.name === "backend")?.startedAt).toBe(263_000);
});

test("fila sem passo iniciado e fim com código", () => {
  expect(parseRun("a-1", "1 plano a linux= windows=rust vm=v\n2 fila")?.isQueued).toBe(true);
  const ended = parseRun("a-1", "1 plano a linux=rust windows= vm=\n9 fim 1");
  expect([ended?.rc, ended?.endedAt]).toEqual([1, 9000]);
  expect(parseRun("a-1", "lixo")).toBe(undefined);
});

test("dono da rodada: a sessão do Hangar que chamou", () => {
  expect(parseRun("a-1", "1 plano a linux=rust windows= vm=\n1 dono pm-x.2")?.owner).toBe("pm-x.2");
  expect(parseRun("a-1", "1 plano a linux=rust windows= vm=")?.owner).toBe(undefined);
});

test("notificação de tarefa de fundo", () => {
  const text =
    "<task-notification>\n<task-id>bx1</task-id>\n<output-file>/t</output-file>\n<status>completed</status>\n</task-notification>";
  expect(parseNotifications(text)).toEqual([{ id: "bx1", status: "completed" }]);
  const semStatus = "<task-notification><task-id>a</task-id></task-notification>";
  expect(parseNotifications(semStatus + text)).toEqual([{ id: "bx1", status: "completed" }]);
});

test("varredura de /proc acha as tarefas vivas e os pids delas", () => {
  const scan = parseFdScan(
    [
      "/proc/10/fd /tmp/claude-1000/-p/s1/tasks/bx1.output",
      "/proc/10/fd /tmp/claude-1000/-p/s1/tasks/bx1.output",
      "/proc/11/fd /tmp/claude-1000/-p/s1/tasks/bx1.output",
      "/proc/12/fd /tmp/claude-1000/-p/s1/tasks/by2.output",
      "lixo",
    ].join("\n"),
  );
  expect(scan.get("bx1")).toEqual({ pids: [10, 11], path: "/tmp/claude-1000/-p/s1/tasks/bx1.output" });
  expect(scan.get("by2")?.pids).toEqual([12]);
  expect(scan.size).toBe(2);
});

test("tarefa que sumiu de /proc é dada como encerrada; recém-nascida espera", () => {
  const scan = parseFdScan("/proc/7/fd /t/tasks/viva.output");
  const out = reconcileShells(
    [
      { id: "viva", command: "a", startedAt: 0 },
      { id: "morta", command: "b", startedAt: 0 },
      { id: "nova", command: "c", startedAt: 99_000 },
      { id: "velha", command: "d", startedAt: 0, endedAt: 50, status: "completed" },
    ],
    scan,
    100_000,
  );
  expect(out.map((s) => [s.id, s.endedAt, s.status])).toEqual([
    ["viva", undefined, undefined],
    ["morta", 100_000, "terminou"],
    ["nova", undefined, undefined],
    ["velha", 50, "completed"],
  ]);
  expect(out[0]?.pids).toEqual([7]);
  expect(out[0]?.path).toBe("/t/tasks/viva.output");
});

test("processo atual: o filho mais novo, nunca o zsh que embrulha o comando", () => {
  const scan = parseFdScan(
    ["/proc/100/fd /t/tasks/laco.output", "/proc/180/fd /t/tasks/laco.output", "/proc/200/fd /t/tasks/so-shell.output"].join("\n"),
  );
  const ps = [
    "  100 /usr/bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'until x; do sleep 15; done'",
    "  180 sleep 15",
    "  200 /usr/bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'echo'",
  ].join("\n");
  const now = currentCommands(ps, scan);
  expect(now.get("laco")).toBe("sleep 15");
  expect(now.has("so-shell")).toBe(false);
});

test("fim do log: última atualização de barra de progresso, sem cor", () => {
  expect(lastLines("a\nb 10%\rb 50%\r\n\u001b[32mok\u001b[0m\n\n", 2)).toEqual(["b 50%", "ok"]);
});
