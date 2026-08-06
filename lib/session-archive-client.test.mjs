import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

function session(overrides) {
  return {
    path: "/p/s.jsonl",
    id: "abc123",
    cwd: "/project",
    created: "2026-08-01T00:00:00.000Z",
    modified: "2026-08-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
    ...overrides,
  };
}

test("sortArchivedSessions：按 archivedAt 降序，缺失/非法日期排最后", async () => {
  const { sortArchivedSessions } = await jiti.import("./session-archive-client.ts");
  const newer = session({ id: "newer", archivedAt: "2026-08-03T00:00:00Z" });
  const older = session({ id: "older", archivedAt: "2026-08-01T00:00:00Z" });
  const missing = session({ id: "missing", archivedAt: undefined });
  const invalid = session({ id: "invalid", archivedAt: "not-a-date" });
  const sorted = sortArchivedSessions([older, missing, newer, invalid]);
  // 缺失/非法日期排最后，且保持原输入相对顺序（missing 原在 invalid 之前）。
  assert.deepEqual(sorted.map((s) => s.id), ["newer", "older", "missing", "invalid"]);
});

test("sortArchivedSessions：空数组安全", async () => {
  const { sortArchivedSessions } = await jiti.import("./session-archive-client.ts");
  assert.deepEqual(sortArchivedSessions([]), []);
});

test("archiveRowTitle：name 优先，其次首消息（截断），最后 id", async () => {
  const { archiveRowTitle } = await jiti.import("./session-archive-client.ts");
  assert.equal(archiveRowTitle(session({ name: "  My session  " })), "My session");
  assert.equal(archiveRowTitle(session({ firstMessage: "  first  " })), "first");
  assert.equal(archiveRowTitle(session({ firstMessage: "x".repeat(80) })), `${"x".repeat(60)}…`);
  assert.equal(archiveRowTitle(session({ name: "", firstMessage: "" })), "abc123");
});

test("toggleDeleteConfirm：同会话再点取消，换会话切换目标", async () => {
  const { toggleDeleteConfirm } = await jiti.import("./session-archive-client.ts");
  const idle = { sessionId: null };
  assert.deepEqual(toggleDeleteConfirm(idle, "a"), { sessionId: "a" });
  assert.deepEqual(toggleDeleteConfirm({ sessionId: "a" }, "a"), { sessionId: null });
  assert.deepEqual(toggleDeleteConfirm({ sessionId: "a" }, "b"), { sessionId: "b" });
});

test("archiveSession：POST 到 /api/sessions/[id]/archive", async () => {
  const { archiveSession } = await jiti.import("./session-archive-client.ts");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ sessionId: "abc123", archivedAt: "2026-08-03T00:00:00Z" }) };
  };
  const result = await archiveSession("abc123", fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/sessions/abc123/archive");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(result, { ok: true, status: 200, error: undefined });
});

test("restoreSession：DELETE 到 /api/sessions/[id]/archive", async () => {
  const { restoreSession } = await jiti.import("./session-archive-client.ts");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ session: session({ id: "abc123" }) }) };
  };
  const result = await restoreSession("abc123", fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/sessions/abc123/archive");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(result.ok, true);
});

test("deleteSessionPermanently：DELETE 到 /api/sessions/[id]（后端自动清理 sidecar）", async () => {
  const { deleteSessionPermanently } = await jiti.import("./session-archive-client.ts");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const result = await deleteSessionPermanently("abc123", fetchImpl);
  assert.equal(calls[0].url, "/api/sessions/abc123");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(result.ok, true);
});

test("失败分类：409 → running，403 → readOnly，网络/解析失败 → network，其它 → other", async () => {
  const { archiveSession, archiveFailureKind } = await jiti.import("./session-archive-client.ts");
  const withStatus = (status, error) => async () => ({ ok: false, status, json: async () => ({ error }) });

  const running = await archiveSession("a", withStatus(409, "Session is running; cannot archive while active"));
  assert.equal(archiveFailureKind(running), "running");
  assert.equal(running.error, "Session is running; cannot archive while active");

  const readOnly = await archiveSession("b", withStatus(403, "Subagent sessions are read-only"));
  assert.equal(archiveFailureKind(readOnly), "readOnly");

  const network = await archiveSession("c", async () => { throw new Error("boom"); });
  assert.equal(network.ok, false);
  assert.equal(network.status, 0);
  assert.equal(archiveFailureKind(network), "network");

  const other = await archiveSession("d", withStatus(500, "boom"));
  assert.equal(archiveFailureKind(other), "other");
});

test("i18n：en 与 zh-CN 归档键一一对应，无遗漏", async () => {
  const { en } = await jiti.import("../lib/locales/en.ts");
  const { zhCN } = await jiti.import("../lib/locales/zh-CN.ts");
  const archiveKeys = Object.keys(en).filter((key) => key.startsWith("archive_") || key === "sidebar_archive" || key === "sidebar_archiveSession").sort();
  assert.ok(archiveKeys.length >= 20, `归档键数量异常：${archiveKeys.length}`);
  for (const key of archiveKeys) {
    assert.ok(key in zhCN, `zh-CN 缺少键 ${key}`);
  }
  const zhArchiveKeys = Object.keys(zhCN).filter((key) => key.startsWith("archive_") || key === "sidebar_archive" || key === "sidebar_archiveSession").sort();
  assert.deepEqual(zhArchiveKeys, archiveKeys, "两个 locale 的归档键集合必须一致");
});
