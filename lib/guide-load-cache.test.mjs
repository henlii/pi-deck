import assert from "node:assert/strict";
import test from "node:test";

import {
  GUIDE_WORKTREE_CACHE_TTL_MS,
  aggregateGuideProjects,
  beginWorktreeLoad,
  clearDefaultWorktreeCache,
  clearWorktreeCache,
  createWorktreeCache,
  getDefaultWorktreeCache,
  resolveGuideTargetProject,
} from "./guide-load-cache.ts";

// ── 项目列表聚合 ──

test("aggregates sessions into recent projects sorted by latest activity", () => {
  const sessions = [
    { cwd: "/a", modified: "2026-08-03T10:00:00.000Z" },
    { cwd: "/b", modified: "2026-08-03T11:00:00.000Z" },
    { cwd: "/a", modified: "2026-08-03T12:00:00.000Z" },
    { created: "2026-08-03T09:00:00.000Z" }, // 无 cwd，忽略
    { cwd: "/c" }, // 无时间，latest=0
  ];
  const projects = aggregateGuideProjects(sessions);
  assert.deepEqual(projects, [
    { cwd: "/a", count: 2, latest: Date.parse("2026-08-03T12:00:00.000Z") },
    { cwd: "/b", count: 1, latest: Date.parse("2026-08-03T11:00:00.000Z") },
    { cwd: "/c", count: 1, latest: 0 },
  ]);
});

test("aggregateGuideProjects respects the limit", () => {
  const sessions = ["/p1", "/p2", "/p3"].map((cwd) => ({ cwd }));
  assert.equal(aggregateGuideProjects(sessions, 2).length, 2);
});

test("resolveGuideTargetProject matches exact project root first", () => {
  const projects = [{ cwd: "/repo" }, { cwd: "/other" }];
  assert.equal(resolveGuideTargetProject(projects, "/repo"), "/repo");
});

test("resolveGuideTargetProject falls back to the longest prefix for nested paths", () => {
  const projects = [{ cwd: "/repo" }, { cwd: "/other" }];
  // 仓库子目录（如 /repo/sub）按前缀归到项目根
  assert.equal(resolveGuideTargetProject(projects, "/repo/sub"), "/repo");
  // 工作树是 repoRoot 的兄弟目录（<repoRoot>-worktrees/<branch>），前缀不同，按原语义不匹配
  assert.equal(resolveGuideTargetProject(projects, "/repo-worktrees/branch-a"), null);
  assert.equal(resolveGuideTargetProject(projects, "/unrelated/path"), null);
});

// ── 工作树加载缓存（in-flight 去重 + SWR）──

const wt = (path, extra = {}) => ({ path, ...extra });

test("worktree load coalesces concurrent calls for the same cwd", async () => {
  const cache = createWorktreeCache();
  let loads = 0;
  let finishLoad;
  const loader = () => {
    loads += 1;
    return new Promise((resolve) => { finishLoad = resolve; });
  };

  const first = beginWorktreeLoad(cache, "/repo", loader);
  const second = beginWorktreeLoad(cache, "/repo", loader);
  await Promise.resolve();

  assert.equal(loads, 1);
  assert.equal(first.promise, second.promise);
  finishLoad([wt("/repo")]);
  assert.deepEqual(await first.promise, [wt("/repo")]);
  assert.equal(cache.inFlight.size, 0);
});

test("worktree load returns stale data immediately and refreshes in background", async () => {
  const cache = createWorktreeCache();
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return [wt(`/repo-${loads}`)];
  };

  const first = beginWorktreeLoad(cache, "/repo", loader);
  assert.equal(first.stale, null);
  assert.deepEqual(await first.promise, [wt("/repo-1")]);
  assert.equal(loads, 1);

  // 第二次加载：立即返回 stale，同时后台刷新
  const second = beginWorktreeLoad(cache, "/repo", loader);
  assert.deepEqual(second.stale, [wt("/repo-1")]);
  const fresh = await second.promise;
  assert.deepEqual(fresh, [wt("/repo-2")]);
  assert.equal(loads, 2);
  // 刷新结果已入缓存，第三次直接命中 stale
  const third = beginWorktreeLoad(cache, "/repo", loader);
  assert.deepEqual(third.stale, [wt("/repo-2")]);
});

test("worktree load failure keeps old data and allows retry", async () => {
  const cache = createWorktreeCache();
  let loads = 0;
  const loader = async () => {
    loads += 1;
    if (loads === 1 || loads === 3) return [wt("/repo")];
    throw new Error("network failed");
  };

  await beginWorktreeLoad(cache, "/repo", loader).promise;
  const failing = beginWorktreeLoad(cache, "/repo", loader);
  assert.deepEqual(failing.stale, [wt("/repo")]);
  await assert.rejects(failing.promise, /network failed/);
  // 失败不覆盖缓存：stale 仍在，且 in-flight 已清理，可重试
  assert.deepEqual(cache.data.get("/repo"), [wt("/repo")]);
  assert.equal(cache.inFlight.has("/repo"), false);

  const retry = beginWorktreeLoad(cache, "/repo", loader);
  assert.deepEqual(await retry.promise, [wt("/repo")]);
  assert.equal(loads, 3);
});

test("worktree loads are kept separate per cwd", async () => {
  const cache = createWorktreeCache();
  const a = await beginWorktreeLoad(cache, "/a", async () => [wt("/a")]).promise;
  const b = await beginWorktreeLoad(cache, "/b", async () => [wt("/b")]).promise;
  assert.deepEqual(a, [wt("/a")]);
  assert.deepEqual(b, [wt("/b")]);
  assert.deepEqual(beginWorktreeLoad(cache, "/a", async () => []).stale, [wt("/a")]);
  assert.deepEqual(beginWorktreeLoad(cache, "/b", async () => []).stale, [wt("/b")]);
});

test("clearWorktreeCache forces a fresh load", async () => {
  const cache = createWorktreeCache();
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return [wt(`/repo-${loads}`)];
  };

  const first = await beginWorktreeLoad(cache, "/repo", loader).promise;
  assert.deepEqual(first, [wt("/repo-1")]);

  clearWorktreeCache(cache, "/repo");
  const second = beginWorktreeLoad(cache, "/repo", loader);
  assert.equal(second.stale, null);
  assert.deepEqual(await second.promise, [wt("/repo-2")]);
  assert.equal(loads, 2);
});

// ── 模块级默认缓存单例 + TTL ──

test("getDefaultWorktreeCache returns one shared singleton", () => {
  // 同一模块实例内多次调用引用相同（跨组件挂载/卸载复用）
  const a = getDefaultWorktreeCache();
  const b = getDefaultWorktreeCache();
  assert.equal(a, b);
  assert.equal(a.data, b.data);
  assert.equal(a.inFlight, b.inFlight);
});

test("worktree stale data expires after the TTL", async () => {
  const cache = createWorktreeCache();
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return [wt(`/repo-${loads}`)];
  };

  const t0 = 1_000_000;
  const first = await beginWorktreeLoad(cache, "/repo", loader, t0).promise;
  assert.deepEqual(first, [wt("/repo-1")]);

  // TTL 内（差值为 TTL-1）：stale 命中，后台刷新
  const within = beginWorktreeLoad(cache, "/repo", loader, t0 + GUIDE_WORKTREE_CACHE_TTL_MS - 1);
  assert.deepEqual(within.stale, [wt("/repo-1")]);

  // TTL 边界（差值 >= TTL）：过期 → stale=null，强制重新请求
  const expired = beginWorktreeLoad(cache, "/repo", loader, t0 + GUIDE_WORKTREE_CACHE_TTL_MS);
  assert.equal(expired.stale, null);
  assert.deepEqual(await expired.promise, [wt("/repo-2")]);
  assert.equal(loads, 2);
});

test("clearDefaultWorktreeCache(cwd) invalidates only that cwd", async () => {
  const cache = getDefaultWorktreeCache();
  const loader = async () => [wt("/repo")];
  await beginWorktreeLoad(cache, "/repo", loader).promise;
  await beginWorktreeLoad(cache, "/other", loader).promise;

  clearDefaultWorktreeCache("/repo");
  assert.equal(beginWorktreeLoad(cache, "/repo", loader).stale, null);
  // 未清理的 cwd 仍命中 stale
  assert.deepEqual(beginWorktreeLoad(cache, "/other", loader).stale, [wt("/repo")]);
});

test("clearDefaultWorktreeCache() without cwd clears everything", async () => {
  const cache = getDefaultWorktreeCache();
  const loader = async () => [wt("/repo")];
  await beginWorktreeLoad(cache, "/repo", loader).promise;

  clearDefaultWorktreeCache();
  const handle = beginWorktreeLoad(cache, "/repo", loader);
  assert.equal(handle.stale, null);
  await handle.promise;
  assert.equal(cache.inFlight.size, 0);
});
