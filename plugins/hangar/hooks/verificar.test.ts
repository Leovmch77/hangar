import { expect, mock, test, tier } from "claude-code/testing";

tier("prepend");

const DIR = "/estado/hangar-verificacao/andamento";
const RUN = ["100 plano abc123 linux=rust windows= vm=", "101 >> linux: rust…"].join("\n");

test("a faixa acima do prompt mostra o verificar-local em andamento e o /andamento abre o painel", async ($, on) => {
  const clock = mock.clock(on, { now: 130_000 });
  const env: Record<string, string> = { XDG_STATE_HOME: "/estado", HOME: "/home/x" };
  on("env.get", ($, e) => ({ value: env[e.name] }));
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("session.cwd", () => ({ value: "/tmp" }));
  on("session.model", () => ({ value: "modelo" }));
  on("session.id", () => ({ value: "sid" }) as never);
  on("http.fetch", () => ({ value: { status: 500, ok: false, text: "", headers: {} } }) as never);
  on("command.register", () => ({ value: undefined }) as never);
  on("fs.list", ($, e) =>
    (e.path === DIR ? { value: [{ name: "abc123-4242", kind: "file", mtimeMs: 125_000 }] } : { value: [] }) as never);
  on("fs.read", () => ({ value: RUN }) as never);
  on("fs.exists", ($, e) => ({ value: e.path === "/proc/4242" }) as never);
  on("process.run", () => ({ value: { exitCode: 0, stdout: "compilando\n", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as never);
  const opened: string[] = [];
  on("ui.open", ($, e) => {
    opened.push(e.id);
    return { value: { isPlaced: true } } as never;
  });

  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await clock.settle();

  const band = await $.ui.mount({ plugin: "hangar", surface: "terminal", component: "AbovePrompt", props: { bodyColumns: 80, hasSurvey: false } as never });
  const text = JSON.stringify(await band.drawn());
  expect(text).toContain("abc123");
  expect(text).toContain("rodando rust 29s");

  const r = await $.command.run({ command: "andamento", args: "" } as never);
  expect((r as { text: string }).text).toBe("Painel de andamento aberto.");
  expect(opened).toEqual(["hangar-andamento"]);
});
