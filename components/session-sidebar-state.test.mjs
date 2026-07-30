import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const load = () => jiti.import("./session-sidebar-state.ts");

/** @param {string} id @param {Partial<import('../lib/types').SessionInfo>} [overrides] */
function session(id, overrides = {}) {
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/repo",
    created: "2026-07-01T00:00:00.000Z",
    modified: "2026-07-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: `msg-${id}`,
    ...overrides,
  };
}

// ── 分组可见条数 ───────────────────────────────────────────────────────────

test("可见条数：默认 5，显示更多每次 +5，显示更少重置", async () => {
  const m = await load();
  assert.equal(m.DEFAULT_GROUP_VISIBLE_COUNT, 5);
  assert.equal(m.GROUP_VISIBLE_PAGE_SIZE, 5);
  assert.equal(m.getGroupVisibleCount({}, "main:/repo"), 5);

  let counts = m.bumpGroupVisibleCount({}, "g1");
  assert.equal(m.getGroupVisibleCount(counts, "g1"), 10);
  counts = m.bumpGroupVisibleCount(counts, "g1");
  assert.equal(m.getGroupVisibleCount(counts, "g1"), 15);

  const reset = m.resetGroupVisibleCount(counts, "g1");
  assert.equal(m.getGroupVisibleCount(reset, "g1"), 5);
  assert.equal("g1" in reset, false);
  // 未记录的 key 重置返回原引用
  const empty = {};
  assert.equal(m.resetGroupVisibleCount(empty, "x"), empty);
});

test("可见条数：脏值回退默认；截取只切顶层节点不拆 child", async () => {
  const m = await load();
  assert.equal(m.getGroupVisibleCount({ g: 0 }, "g"), 5);
  assert.equal(m.getGroupVisibleCount({ g: NaN }, "g"), 5);
  assert.equal(m.getGroupVisibleCount({ g: 3.7 }, "g"), 5);
  assert.equal(m.getGroupVisibleCount({ g: 12.9 }, "g"), 12);

  const nodes = [
    { id: "a", children: [{ id: "a1" }, { id: "a2" }] },
    { id: "b", children: [{ id: "b1" }] },
    { id: "c", children: [] },
    { id: "d", children: [] },
    { id: "e", children: [] },
    { id: "f", children: [] },
  ];
  const visible = m.getVisibleTopLevelNodes(nodes, 5, false);
  assert.equal(visible.length, 5);
  assert.deepEqual(visible.map((n) => n.id), ["a", "b", "c", "d", "e"]);
  // child tree 完整保留（同一引用）
  assert.equal(visible[0], nodes[0]);
  assert.equal(visible[0].children.length, 2);

  // 搜索激活：返回全部（引用相等）
  assert.equal(m.getVisibleTopLevelNodes(nodes, 5, true), nodes);
  // 可见数 ≥ 总数：引用相等
  assert.equal(m.getVisibleTopLevelNodes(nodes, 100, false), nodes);

  assert.equal(m.canShowMoreTopLevel(6, 5, false), true);
  assert.equal(m.canShowMoreTopLevel(5, 5, false), false);
  assert.equal(m.canShowMoreTopLevel(6, 5, true), false);
  assert.equal(m.canShowFewerTopLevel(10, false), true);
  assert.equal(m.canShowFewerTopLevel(5, false), false);
  assert.equal(m.canShowFewerTopLevel(10, true), false);
});

// ── 乐观会话合并 ───────────────────────────────────────────────────────────

test("乐观合并：server 同 id 替换 pending；stale server 不删 pending 集合项", async () => {
  const m = await load();
  const pendingA = session("a", { name: "optimistic-a", modified: "2026-07-10T00:00:00.000Z" });
  const pendingB = session("b", { name: "optimistic-b", modified: "2026-07-09T00:00:00.000Z" });
  const serverA = session("a", { name: "server-a", modified: "2026-07-10T01:00:00.000Z" });
  const serverC = session("c", { name: "server-c", modified: "2026-07-08T00:00:00.000Z" });

  // 正常回流：server 带 a、c；pending 有 a、b → a 被 server 替换，b 保留
  const merged = m.mergeOptimisticSessions({
    serverSessions: [serverA, serverC],
    pendingSessions: [pendingA, pendingB],
  });
  assert.deepEqual(merged.map((s) => s.id), ["a", "b", "c"]);
  assert.equal(merged.find((s) => s.id === "a")?.name, "server-a");
  assert.equal(merged.find((s) => s.id === "b")?.name, "optimistic-b");

  // stale server：只带回 c，但 b 仍在 pendingIds → b 不得消失
  const stale = m.mergeOptimisticSessions({
    serverSessions: [serverC],
    pendingSessions: [pendingB],
    pendingIds: new Set(["b"]),
  });
  assert.deepEqual(stale.map((s) => s.id).sort(), ["b", "c"]);
});

test("乐观合并：显式删除 id 可移除；排序按 modified/created 稳定", async () => {
  const m = await load();
  const a = session("a", { modified: "2026-07-05T00:00:00.000Z", created: "2026-07-01T00:00:00.000Z" });
  const b = session("b", { modified: "2026-07-05T00:00:00.000Z", created: "2026-07-02T00:00:00.000Z" });
  const c = session("c", { modified: "2026-07-06T00:00:00.000Z", created: "2026-07-01T00:00:00.000Z" });
  // 同 modified+created 时 id 升序
  const d1 = session("d1", { modified: "2026-07-04T00:00:00.000Z", created: "2026-07-01T00:00:00.000Z" });
  const d2 = session("d2", { modified: "2026-07-04T00:00:00.000Z", created: "2026-07-01T00:00:00.000Z" });

  const sorted = m.mergeOptimisticSessions({
    serverSessions: [a, b, c, d2, d1],
    pendingSessions: [],
  });
  assert.deepEqual(sorted.map((s) => s.id), ["c", "b", "a", "d1", "d2"]);

  const deleted = m.mergeOptimisticSessions({
    serverSessions: [a, b, c],
    pendingSessions: [session("p", { modified: "2026-07-07T00:00:00.000Z" })],
    deletedIds: new Set(["b", "p"]),
  });
  assert.deepEqual(deleted.map((s) => s.id), ["c", "a"]);
});

test("pending id 回流：server 出现后从 pending 集合剔除；无变化返回原引用", async () => {
  const m = await load();
  const pending = new Set(["a", "b"]);
  const next = m.reconcilePendingSessionIds(pending, [session("a"), session("c")]);
  assert.deepEqual([...next].sort(), ["b"]);
  const same = m.reconcilePendingSessionIds(next, [session("c")]);
  assert.equal(same, next);
  const empty = new Set();
  assert.equal(m.reconcilePendingSessionIds(empty, [session("x")]), empty);
});

test("多 pending A/B：逐 id 回流；stale server 不丢另一条", async () => {
  const m = await load();
  const pendingA = session("sid-a", {
    name: "optimistic-a",
    modified: "2026-07-12T00:00:00.000Z",
  });
  const pendingB = session("sid-b", {
    name: "optimistic-b",
    modified: "2026-07-11T00:00:00.000Z",
  });
  const pendingIds = new Set(["sid-a", "sid-b"]);

  // R1 只带回 B：A 必须保留
  const afterR1 = m.mergeOptimisticSessions({
    serverSessions: [session("sid-b", { name: "server-b", modified: "2026-07-11T01:00:00.000Z" })],
    pendingSessions: [pendingA, pendingB],
    pendingIds,
  });
  assert.deepEqual(afterR1.map((s) => s.id).sort(), ["sid-a", "sid-b"]);
  assert.equal(afterR1.find((s) => s.id === "sid-b")?.name, "server-b");
  assert.equal(afterR1.find((s) => s.id === "sid-a")?.name, "optimistic-a");

  const pendingAfterB = m.reconcilePendingSessionIds(pendingIds, [
    session("sid-b"),
  ]);
  assert.deepEqual([...pendingAfterB].sort(), ["sid-a"]);

  // R2 带回 A：A 被 server 替换并离开 pending
  const afterR2 = m.mergeOptimisticSessions({
    serverSessions: [
      session("sid-a", { name: "server-a", modified: "2026-07-12T02:00:00.000Z" }),
      session("sid-b", { name: "server-b", modified: "2026-07-11T01:00:00.000Z" }),
    ],
    pendingSessions: [pendingA],
    pendingIds: pendingAfterB,
  });
  assert.equal(afterR2.find((s) => s.id === "sid-a")?.name, "server-a");
  assert.deepEqual(
    [...m.reconcilePendingSessionIds(pendingAfterB, afterR2)].sort(),
    [],
  );
});

test("乱序 list 响应：仅最新 gen 可写 server/error/loading", async () => {
  const m = await load();
  // R1 gen=1，随后 R2 gen=2 成为最新 → R1 迟到不得 apply
  assert.equal(m.shouldApplySessionListResponse(1, 2), false);
  assert.equal(m.shouldApplySessionListResponse(2, 2), true);
  assert.equal(m.shouldApplySessionListResponse(0, 0), false);
  assert.equal(m.shouldApplySessionListResponse(3, 3), true);
});

test("worktree preload generation 不含 session refreshKey", async () => {
  const m = await load();
  assert.equal(m.buildWorktreePreloadGeneration(0), "wt:0");
  assert.equal(m.buildWorktreePreloadGeneration(4), "wt:4");
  assert.equal(m.buildWorktreePreloadGeneration(4.9), "wt:4");
  // 契约：字符串前缀固定 wt:，不得出现 session 相关 token
  const gen = m.buildWorktreePreloadGeneration(7);
  assert.match(gen, /^wt:\d+$/);
  assert.equal(gen.includes("refresh"), false);
  assert.equal(gen.includes("session"), false);
});

// ── 项目 worktree 快照 ─────────────────────────────────────────────────────

const wt = (path, branch = "main", isMain = false) => ({ path, branch, isMain });

test("worktree 快照：loading/error 保留 last-known；单项目错误不影响其他", async () => {
  const m = await load();
  let map = {};
  map = m.upsertProjectWorktreeSnapshot(map, "/repo-a", {
    status: "ready",
    worktrees: [wt("/repo-a", "main", true), wt("/repo-a-wt/feat", "feat")],
  });
  map = m.upsertProjectWorktreeSnapshot(map, "/repo-b", {
    status: "ready",
    worktrees: [wt("/repo-b", "main", true)],
  });

  // loading 保留 a 的列表
  const loading = m.upsertProjectWorktreeSnapshot(map, "/repo-a", { status: "loading" });
  assert.equal(loading["/repo-a"].status, "loading");
  assert.equal(loading["/repo-a"].worktrees.length, 2);
  assert.equal(loading["/repo-b"].status, "ready");

  // error 保留 last-known，不影响 b
  const errored = m.upsertProjectWorktreeSnapshot(loading, "/repo-a", {
    status: "error",
    error: "network",
  });
  assert.equal(errored["/repo-a"].status, "error");
  assert.equal(errored["/repo-a"].error, "network");
  assert.equal(errored["/repo-a"].worktrees.length, 2);
  assert.equal(errored["/repo-b"].worktrees.length, 1);
  assert.equal(errored["/repo-b"].status, "ready");
});

test("worktree 快照：相同列表不触发更新；idle 清空；remove 只删目标", async () => {
  const m = await load();
  const list = [wt("/repo", "main", true)];
  let map = m.upsertProjectWorktreeSnapshot({}, "/repo", { status: "ready", worktrees: list });
  const same = m.upsertProjectWorktreeSnapshot(map, "/repo", {
    status: "ready",
    worktrees: [wt("/repo", "main", true)],
  });
  assert.equal(same, map);

  const idle = m.upsertProjectWorktreeSnapshot(map, "/repo", { status: "idle" });
  assert.notEqual(idle, map);
  assert.equal(idle["/repo"].status, "idle");
  assert.deepEqual(idle["/repo"].worktrees, []);

  map = m.upsertProjectWorktreeSnapshot(map, "/other", { status: "ready", worktrees: list });
  const removed = m.removeProjectWorktreeSnapshot(map, "/repo");
  assert.equal("/repo" in removed, false);
  assert.equal("/other" in removed, true);
  assert.equal(m.removeProjectWorktreeSnapshot(removed, "/missing"), removed);
});

test("worktree 列表比较：path/branch/isMain 顺序敏感", async () => {
  const m = await load();
  assert.equal(m.sameWorktreeList([], []), true);
  assert.equal(
    m.sameWorktreeList([wt("/a", "x", true)], [wt("/a", "x", true)]),
    true,
  );
  assert.equal(
    m.sameWorktreeList([wt("/a", "x", true)], [wt("/a", "y", true)]),
    false,
  );
  assert.equal(
    m.sameWorktreeList([wt("/a"), wt("/b")], [wt("/b"), wt("/a")]),
    false,
  );
});
