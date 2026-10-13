import { expect, test } from "claude-code/testing";
import { parseNotifications } from "./verificarParse";
import { agentEnd, contentText } from "./state";

test("a task-notification da linha vira o fim do subagente", () => {
  const content = [{ type: "text", text: "<task-notification>\n<task-id>af289ebc016b47e48</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n</task-notification>" }];
  const done = parseNotifications(contentText(content));
  expect(done).toEqual([{ id: "af289ebc016b47e48", status: "completed" }]);
  expect(done.map((d) => agentEnd(d.status))).toEqual(["finished"]);
});

test("só completed é fim normal", () => {
  expect(["failed", "killed"].map(agentEnd)).toEqual(["failed", "failed"]);
  expect(contentText("texto")).toBe("texto");
  expect(contentText(undefined)).toBe("");
});
