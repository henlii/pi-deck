/**
 * GET /api/sessions/[id]/info 路由契约：200/404/400；不启动 AgentSession。
 * 通过源码静态契约 + sessionService.getSessionInfo 语义对齐验证。
 * 放在 lib/ 以便 npm test 的 shell glob 能稳定发现（避免 app 路径中的 []）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const routeSource = readFileSync(
  join(root, "app", "api", "sessions", "[id]", "info", "route.ts"),
  "utf8",
);
const jiti = createJiti(import.meta.url);
const { createSessionService } = await jiti.import("./session-service.ts");

test("info route：强制 dynamic；只读 getSessionInfo；无 startRpcSession", () => {
  assert.match(routeSource, /export const dynamic = "force-dynamic"/);
  assert.match(routeSource, /sessionService\.getSessionInfo/);
  assert.doesNotMatch(routeSource, /startRpcSession|ensureLive|getLive|createNew/);
  assert.match(routeSource, /status: 404/);
  assert.match(routeSource, /status: 400/);
});

test("getSessionInfo 语义：命中 200 体；缺失 null→路由 404；不启动 AgentSession", async () => {
  let started = 0;
  const target = {
    id: "s-info",
    cwd: "/proj",
    path: "/tmp/s-info.jsonl",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-02T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hi",
    projectRoot: "/proj",
  };
  const service = createSessionService({
    listAllSessions: async () => [target],
    startRpcSession: async () => {
      started += 1;
      throw new Error("不应启动");
    },
    getRpcSession: () => undefined,
  });

  assert.deepEqual(await service.getSessionInfo("s-info"), target);
  assert.equal(await service.getSessionInfo("missing"), null);
  assert.equal(await service.getSessionInfo(""), null);
  assert.equal(started, 0);
});
