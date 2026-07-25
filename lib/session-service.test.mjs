import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSessionService } = await jiti.import("./session-service.ts");

function createFakeSession(id = "live-1") {
  const calls = [];
  return {
    id,
    isAlive: () => true,
    send: async (command) => {
      calls.push(command);
      return { ok: true, command };
    },
    calls,
  };
}

test("listSessions 聚合会话列表与运行中 id", async () => {
  const service = createSessionService({
    listAllSessions: async () => [{ id: "s1", cwd: "/tmp", path: "/tmp/s1.jsonl", created: "", modified: "", messageCount: 0, firstMessage: "" }],
    getRunningRpcSessionIds: () => ["s1"],
  });

  const result = await service.listSessions();
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.runningSessionIds, ["s1"]);
});

test("send 优先走 live 会话快路径", async () => {
  const live = createFakeSession("live-1");
  let started = false;
  const service = createSessionService({
    getRpcSession: (id) => (id === "live-1" ? live : undefined),
    startRpcSession: async () => {
      started = true;
      throw new Error("should not start");
    },
    resolveSessionPath: async () => {
      throw new Error("should not resolve");
    },
  });

  const data = await service.send("live-1", { type: "get_state" });
  assert.equal(started, false);
  assert.deepEqual(live.calls, [{ type: "get_state" }]);
  assert.equal(data.ok, true);
});

test("send 在会话不存在时抛出 Session not found", async () => {
  const service = createSessionService({
    getRpcSession: () => undefined,
    resolveSessionPath: async () => null,
  });

  await assert.rejects(() => service.send("missing", { type: "get_state" }), /Session not found/);
});

test("createNew ensure_session 不发送首条 prompt", async () => {
  const live = createFakeSession("new-1");
  const allowed = [];
  let invalidated = false;
  const service = createSessionService({
    existsSync: () => true,
    now: () => 123,
    startRpcSession: async (sessionId, sessionFile, cwd, toolNames) => {
      assert.equal(sessionId, "__new__123");
      assert.equal(sessionFile, "");
      assert.equal(cwd, "/project");
      assert.deepEqual(toolNames, ["read"]);
      return { session: live, realSessionId: "new-1" };
    },
    allowFileRoot: (root) => allowed.push(root),
    invalidateSessionListCache: () => {
      invalidated = true;
    },
  });

  const result = await service.createNew({
    cwd: "/project",
    command: {
      type: "ensure_session",
      toolNames: ["read"],
      provider: "p",
      modelId: "m",
      thinkingLevel: "low",
    },
  });

  assert.equal(result.sessionId, "new-1");
  assert.equal(result.data, null);
  assert.deepEqual(allowed, ["/project"]);
  assert.equal(invalidated, true);
  assert.deepEqual(live.calls, [
    { type: "set_model", provider: "p", modelId: "m" },
    { type: "set_thinking_level", level: "low" },
  ]);
});

test("只读 subagent 的 start/send 都不会启动 wrapper", async () => {
  let started = 0;
  const service = createSessionService({
    listAllSessions: async () => [{ id: "child", cwd: "/tmp", path: "/tmp/child.jsonl", created: "", modified: "", messageCount: 0, firstMessage: "", readOnly: true }],
    startRpcSession: async () => { started += 1; throw new Error("不应启动"); },
    getRpcSession: () => undefined,
    resolveSessionPath: async () => "/tmp/child.jsonl",
  });
  await assert.rejects(() => service.start("child", "/tmp/child.jsonl", "/tmp"), /read-only/);
  await assert.rejects(() => service.send("child", { type: "prompt" }), /read-only/);
  assert.equal(started, 0);
});
