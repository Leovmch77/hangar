import { expect, test } from "claude-code/testing";

import { parseNotifications, parseRun } from "./verificarParse";

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

test("notificação de tarefa de fundo", () => {
  const text =
    "<task-notification>\n<task-id>bx1</task-id>\n<output-file>/t</output-file>\n<status>completed</status>\n</task-notification>";
  expect(parseNotifications(text)).toEqual([{ id: "bx1", status: "completed" }]);
});
