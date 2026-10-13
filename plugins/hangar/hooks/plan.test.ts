import { expect, test } from "claude-code/testing";
import { notifyPlan } from "./plan";

const PONTE = { url: "http://127.0.0.1:1/api/plugin", token: "tok", sessao: "s" };

test("avisa o plano pela rota que não segura", async () => {
  const posts: { url: string; body: unknown }[] = [];
  const $ = { http: { fetch: async (url: string, init?: { body?: string }) => {
    posts.push({ url, body: JSON.parse(init?.body ?? "null") });
    return { status: 200, text: "{}" };
  } } } as never;
  await notifyPlan($, PONTE, "toolu_1", { plan: "# Plano", planFilePath: "/p.md" });
  expect(posts).toEqual([{ url: "http://127.0.0.1:1/api/plugin/plan",
    body: { sessao: "s", token: "tok", id: "plan:toolu_1", plan: "# Plano", path: "/p.md" } }]);
});

test("ponte fora do ar não derruba o diálogo", async () => {
  const $ = { http: { fetch: async () => { throw new Error("fora"); } } } as never;
  await notifyPlan($, PONTE, "toolu_1", {});
});
