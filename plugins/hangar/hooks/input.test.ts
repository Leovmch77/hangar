import { expect, mock, test, tier } from "claude-code/testing";
import { returnFocus } from "./input";

// Como na sessão do Hangar: o plugin entra por `--plugin-dir`.
tier("prepend");

test("sem terminal: o `/pull` só declara agent_message, entrega ao subagente e ignora prompt", {}, async ($, on) => {
  const relogio = mock.clock(on, { now: 1_000_000 });
  const env: Record<string, string> = {
    HANGAR_PLUGIN_URL: "http://127.0.0.1:1/api/plugin", HANGAR_PLUGIN_TOKEN: "tok", CP_SESSION_NAME: "sessao-h",
  };
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const enviados: { to: string; text: string }[] = [];
  const prompts: string[] = [];
  const respostas = [
    '{"text":"oi","modo":"user","publication_id":"p","generation":1}',
    '{"text":null,"agent_message":{"id":"m1","to":"a1","text":"olá"}}',
  ];
  on("env.get", ($, e) => ({ value: env[e.name] }));
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("session.cwd", () => ({ value: "/tmp" }));
  on("session.model", () => ({ value: "modelo" }));
  on("session.id", () => ({ value: "sid" }) as never);
  on("command.register", () => ({ value: undefined }) as never);
  on("session.send", ($, e) => {
    enviados.push({ to: e.to, text: e.text });
    return { isDelivered: true } as never;
  });
  on("prompt.submit", ($, e) => {
    prompts.push(e.text);
    return { text: e.text };
  });
  on("http.fetch", ($, e) => {
    const path = e.url.slice(e.url.lastIndexOf("/") + 1);
    posts.push({ path, body: JSON.parse(e.init?.body as string) });
    const text = path === "pull" ? respostas.shift() : '{"ok":true}';
    const status = text === undefined ? 500 : 200;
    return { value: { status, ok: status === 200, headers: {}, text: text ?? "" } } as never;
  });
  await $.session.start({ cwd: "/tmp", surface: null, isInteractive: false });
  await relogio.advance(60);
  await relogio.advance(60);

  const pulls = posts.filter((p) => p.path === "pull").map((p) => p.body);
  expect(pulls.length).toBeGreaterThanOrEqual(2);
  for (const pull of pulls) expect(pull).toMatchObject({ sessao: "sessao-h", token: "tok", modos: ["agent_message"], session_id: "sid" });
  expect(pulls[0]!.estado).toBeUndefined();
  expect(enviados).toEqual([{ to: "a1", text: "olá" }]);
  expect(posts.filter((p) => p.path === "agent-sent").map((p) => p.body)).toEqual([
    { sessao: "sessao-h", token: "tok", id: "m1", isDelivered: true },
  ]);
  // A entrada da sessão sem terminal é do stdin do runtime: nada de prompt nem recibo por aqui.
  expect(prompts).toEqual([]);
  expect(posts.map((p) => p.path).filter((p) => p !== "pull" && p !== "agent-sent" && p !== "ui")).toEqual([]);
});

/** Composer de mentira: `typed` é a tecla da pessoa que chega logo depois do espaço; `failBack` recusa a volta. */
function composer(draft: string, opts: { typed?: string; failBack?: boolean } = {}) {
  const box = { text: draft };
  const read = async () => ({ text: box.text });
  const fill = async (a: { text: string; mode: "append" | "replace" }) => {
    if (a.mode === "replace" && opts.failBack) return { isFilled: false };
    box.text = a.mode === "append" ? box.text + a.text + (opts.typed ?? "") : a.text;
    return { isFilled: true };
  };
  return { box, read, fill };
}

test("devolve o foco e deixa o rascunho como estava", async () => {
  const c = composer("ls -la");
  expect(await returnFocus(c.read, c.fill)).toEqual({ moved: true, restored: true });
  expect(c.box.text).toBe("ls -la");
});

test("uma tecla da pessoa no meio fica no rascunho", async () => {
  const c = composer("ls", { typed: "x" });
  expect(await returnFocus(c.read, c.fill)).toEqual({ moved: true, restored: true });
  expect(c.box.text).toBe("ls x");
});

test("a volta do rascunho que falha não desfaz a devolução do foco, e é avisada", async () => {
  const c = composer("ls", { failBack: true });
  expect(await returnFocus(c.read, c.fill)).toEqual({ moved: true, restored: false });
  expect(c.box.text).toBe("ls ");
});

test("o espaço que lança ainda tenta restaurar", async () => {
  const c = composer("ls");
  const fill = async (a: { text: string; mode: "append" | "replace" }) => {
    if (a.mode === "append") { c.box.text += " "; throw new Error("fill"); }
    return c.fill(a);
  };
  await expect(returnFocus(c.read, fill)).rejects.toThrow("fill");
  expect(c.box.text).toBe("ls");
});
