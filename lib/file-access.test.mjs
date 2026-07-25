import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getAllowedRootsFromSessions } = await jiti.import("./file-access.ts");

test("只读 subagent 的 cwd/projectRoot 不扩大文件授权根", () => {
  const roots = getAllowedRootsFromSessions([
    { id: "parent", path: "/safe/parent.jsonl", cwd: "/safe", projectRoot: "/safe", created: "", modified: "", messageCount: 0, firstMessage: "" },
    { id: "child", path: "/outside/child.jsonl", cwd: "/outside", projectRoot: "/outside", readOnly: true, created: "", modified: "", messageCount: 0, firstMessage: "" },
  ]);
  assert.deepEqual([...roots], ["/safe"]);
});
