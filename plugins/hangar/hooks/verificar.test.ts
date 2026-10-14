import { expect, mock, test, tier } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";

tier("prepend");

const DIR = "/estado/hangar-verificacao/andamento";

/** Sessão com um arquivo de andamento `abc123-4242`; `alive` diz se o pid 4242 existe. Devolve a faixa desenhada. */
async function band($: Engine, on: On, run: string, alive: boolean, opened: string[] = [], session = ""): Promise<string> {
  const clock = mock.clock(on, { now: 130_000 });
  const env: Record<string, string> = { XDG_STATE_HOME: "/estado", HOME: "/home/x", CP_SESSION_NAME: session };
  on("env.get", ($, e) => ({ value: env[e.name] }));
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("session.cwd", () => ({ value: "/tmp" }));
  on("session.model", () => ({ value: "modelo" }));
  on("session.id", () => ({ value: "sid" }) as never);
  on("http.fetch", () => ({ value: { status: 500, ok: false, text: "", headers: {} } }) as never);
  on("command.register", () => ({ value: undefined }) as never);
  on("fs.list", ($, e) =>
    (e.path === DIR ? { value: [{ name: "abc123-4242", kind: "file", mtimeMs: 125_000 }] } : { value: [] }) as never);
  on("fs.read", () => ({ value: run }) as never);
  on("fs.exists", ($, e) => ({ value: alive && e.path === "/proc/4242" }) as never);
  on("process.run", () => ({ value: { exitCode: 0, stdout: "compilando\n", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as never);
  on("ui.open", ($, e) => {
    opened.push(e.id);
    return { value: { isPlaced: true } } as never;
  });
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await clock.settle();
  // Faixa sem nada a mostrar passa a vez; sem outro mod embaixo, o mount não acha quem desenhe.
  const drawn = await $.ui
    .mount({ plugin: "hangar", surface: "terminal", component: "AbovePrompt", props: { bodyColumns: 80, hasSurvey: false } as never })
    .catch((err: unknown) => {
      if (String(err).includes("no implementation for ui.render")) return undefined;
      throw err;
    });
  return drawn ? JSON.stringify(await drawn.drawn()) : "";
}

test("a faixa acima do prompt mostra o verificar-local em andamento e o /andamento abre o painel", async ($, on) => {
  const opened: string[] = [];
  const text = await band($, on, "100 plano abc123 linux=rust windows= vm=\n101 >> linux: rust…", true, opened);
  expect(text).toContain("abc123");
  expect(text).toContain("rodando rust 29s");

  const r = await $.command.run({ command: "andamento", args: "" } as never);
  expect((r as { text: string }).text).toBe("Painel de andamento aberto.");
  expect(opened).toEqual(["hangar-andamento"]);
});

test("fim 0 com passo que nem começou é rodada interrompida, não ok", async ($, on) => {
  const text = await band($, on, "100 plano abc123 linux=rust windows= vm=\n101 fim 0", false);
  expect(text).toContain("interrompida");
});

test("a rodada só aparece na sessão que chamou", async ($, on) => {
  const run = "100 plano abc123 linux=rust windows= vm=\n100 dono pm-a\n101 >> linux: rust…";
  expect(await band($, on, run, true, [], "pm-a")).toContain("abc123");
});

test("rodada de outra sessão não aparece", async ($, on) => {
  const run = "100 plano abc123 linux=rust windows= vm=\n100 dono pm-a\n101 >> linux: rust…";
  expect(await band($, on, run, true, [], "pm-b")).not.toContain("abc123");
});
