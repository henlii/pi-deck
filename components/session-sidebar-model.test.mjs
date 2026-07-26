import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

let seq = 0;
function session(id, overrides = {}) {
  seq += 1;
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/repo-a",
    created: "2026-07-01T00:00:00.000Z",
    modified: `2026-07-0${(seq % 8) + 1}T00:00:00.000Z`,
    messageCount: 1,
    firstMessage: `msg-${id}`,
    ...overrides,
  };
}

test("多项目：按 projectRoot ?? cwd 分项目，按最近活动降序", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const a = session("a1", { cwd: "/repo-a", projectRoot: "/repo-a", modified: "2026-07-01T00:00:00.000Z" });
  const b = session("b1", { cwd: "/repo-b", projectRoot: "/repo-b", modified: "2026-07-09T00:00:00.000Z" });
  // 无 projectRoot 的会话回退 cwd 作为项目根。
  const c = session("c1", { cwd: "/plain-dir", projectRoot: undefined, modified: "2026-07-05T00:00:00.000Z" });
  const tree = buildSidebarTree([a, b, c]);
  assert.deepEqual(tree.map((p) => p.root), ["/repo-b", "/plain-dir", "/repo-a"]);
  assert.equal(tree.length, 3);
});

test("主 worktree 隐式：主仓会话直接挂项目下，不产生 worktree 分组", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const main1 = session("m1", { cwd: "/repo", projectRoot: "/repo" });
  const main2 = session("m2", { cwd: "/repo", projectRoot: "/repo" });
  const tree = buildSidebarTree([main1, main2]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].worktrees.length, 0);
  assert.deepEqual(tree[0].mainTree.map((n) => n.session.id).sort(), ["m1", "m2"]);
});

test("非主 worktree 分组：cwd !== projectRoot 的会话归入分组并带分支名", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const main = session("m", { cwd: "/repo", projectRoot: "/repo" });
  const wt = session("w1", {
    cwd: "/repo-worktrees/feat-login",
    projectRoot: "/repo",
    worktreeBranch: "feat/login",
  });
  const tree = buildSidebarTree([main, wt]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].mainTree.length, 1);
  assert.equal(tree[0].worktrees.length, 1);
  assert.equal(tree[0].worktrees[0].path, "/repo-worktrees/feat-login");
  assert.equal(tree[0].worktrees[0].branch, "feat/login");
  assert.equal(tree[0].worktrees[0].tree[0].session.id, "w1");
});

test("fork/subagent child 语义在项目树分组内原样保留", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const parent = session("p", { cwd: "/repo", projectRoot: "/repo", modified: "2026-07-09T00:00:00.000Z" });
  const fork = session("f", { cwd: "/repo", projectRoot: "/repo", parentSessionId: "p", modified: "2026-07-08T00:00:00.000Z" });
  const sub = session("s", {
    cwd: "/repo", projectRoot: "/repo",
    subagent: { parentSessionId: "p", runId: "r1", runIndex: 0 },
    readOnly: true,
  });
  // worktree 组内同样保留嵌套关系。
  const wtParent = session("wp", { cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat", modified: "2026-07-09T00:00:00.000Z" });
  const wtChild = session("wc", { cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat", parentSessionId: "wp" });
  const tree = buildSidebarTree([parent, fork, sub, wtParent, wtChild]);
  const mainTree = tree[0].mainTree;
  assert.equal(mainTree.length, 1);
  assert.deepEqual(mainTree[0].children.map((n) => [n.session.id, n.relation]), [["s", "subagent"], ["f", "fork"]]);
  assert.equal(tree[0].worktrees[0].tree[0].children[0].session.id, "wc");
  assert.equal(tree[0].worktrees[0].tree[0].children[0].relation, "fork");
  // 输入 SessionInfo 不被修改。
  assert.equal(sub.parentSessionId, undefined);
});

test("孤儿/循环降级在分组内保留：父缺失的 subagent 成为组内根项", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const orphan = session("o", {
    cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat",
    subagent: { parentSessionId: "ghost", runId: "r1", runIndex: 1 },
    readOnly: true,
  });
  const tree = buildSidebarTree([orphan]);
  assert.equal(tree[0].worktrees[0].tree.length, 1);
  assert.equal(tree[0].worktrees[0].tree[0].relation, null);
});

test("搜索命中 child 时保留完整 project → worktree → session 祖先链", async () => {
  const { buildSidebarTree, filterSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const parent = session("p", { cwd: "/repo", projectRoot: "/repo", name: "main work" });
  const fork = session("f", { cwd: "/repo", projectRoot: "/repo", parentSessionId: "p", firstMessage: "investigate flaky" });
  const wtParent = session("wp", { cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat", name: "wt root" });
  const wtChild = session("wc", {
    cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat",
    parentSessionId: "wp",
    subagent: undefined,
    firstMessage: "ordinary child",
  });
  const wtSub = session("ws", {
    cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat",
    subagent: { parentSessionId: "wc", runId: "r9", runIndex: 2, agent: "explore" },
    readOnly: true,
  });
  const otherProject = session("x", { cwd: "/other", projectRoot: "/other", name: "unrelated" });
  const tree = buildSidebarTree([parent, fork, wtParent, wtChild, wtSub, otherProject]);
  const filtered = filterSidebarTree(tree, "explore");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].root, "/repo");
  // 主仓未命中被剪掉，但项目与命中 worktree 组保留。
  assert.equal(filtered[0].mainTree.length, 0);
  assert.equal(filtered[0].worktrees.length, 1);
  const wtTree = filtered[0].worktrees[0].tree;
  assert.equal(wtTree[0].session.id, "wp");
  assert.equal(wtTree[0].children[0].session.id, "wc");
  assert.equal(wtTree[0].children[0].children[0].session.id, "ws");
  assert.equal(wtTree[0].children[0].children[0].relation, "subagent");
});

test("搜索命中项目根路径保留整个项目；命中分支名保留整个分组", async () => {
  const { buildSidebarTree, filterSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const main = session("m", { cwd: "/repo", projectRoot: "/repo", name: "zzz" });
  const wt = session("w", { cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat/login", name: "zzz" });
  const tree = buildSidebarTree([main, wt]);
  // 命中项目根：整棵树原样（引用相等，未做无谓克隆）。
  assert.equal(filterSidebarTree(tree, "repo")[0], tree[0]);
  // 命中分支名：分组原样保留，主仓未命中被剪掉。
  const byBranch = filterSidebarTree(tree, "feat/login");
  assert.equal(byBranch.length, 1);
  assert.equal(byBranch[0].mainTree.length, 0);
  assert.equal(byBranch[0].worktrees[0], tree[0].worktrees[0]);
  // 空查询原样返回；无匹配返回空。
  assert.equal(filterSidebarTree(tree, ""), tree);
  assert.deepEqual(filterSidebarTree(tree, "no-such-thing"), []);
});

test("无会话的 selectedCwd 也必须显示为可用项目项（置顶）", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const existing = session("a", { cwd: "/repo-a", projectRoot: "/repo-a" });
  const tree = buildSidebarTree([existing], { selectedCwd: "/new-project", selectedProjectRoot: "/new-project" });
  assert.equal(tree.length, 2);
  assert.equal(tree[0].root, "/new-project");
  assert.equal(tree[0].mainTree.length, 0);
  assert.equal(tree[0].worktrees.length, 0);
  assert.equal(tree[0].latestActivity, "");
});

test("selectedCwd 属于已有项目的空 worktree：knownWorktrees 补齐空分组", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const main = session("m", { cwd: "/repo", projectRoot: "/repo" });
  const tree = buildSidebarTree([main], {
    selectedCwd: "/repo-worktrees/empty",
    selectedProjectRoot: "/repo",
    knownWorktrees: [
      { path: "/repo", branch: "main", isMain: true },
      { path: "/repo-worktrees/empty", branch: "empty-branch", isMain: false },
    ],
  });
  assert.equal(tree.length, 1);
  // 主 worktree 隐式：不为其生成分组行。
  assert.equal(tree[0].worktrees.length, 1);
  assert.equal(tree[0].worktrees[0].path, "/repo-worktrees/empty");
  assert.equal(tree[0].worktrees[0].branch, "empty-branch");
  assert.equal(tree[0].worktrees[0].tree.length, 0);
});

test("Collapse all 收集全部项目根与 worktree 路径；Expand all 即清空集合", async () => {
  const { buildSidebarTree, collectAllCollapseIds } = await jiti.import("./session-sidebar-model.ts");
  const main = session("m", { cwd: "/repo", projectRoot: "/repo" });
  const wt = session("w", { cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat" });
  const other = session("o", { cwd: "/other", projectRoot: "/other" });
  const tree = buildSidebarTree([main, wt, other]);
  const ids = collectAllCollapseIds(tree);
  assert.deepEqual(ids.projectRoots.sort(), ["/other", "/repo"]);
  assert.deepEqual(ids.worktreePaths, ["/repo-worktrees/feat"]);
});

test("会话定位：返回项目根、非主 worktree 分组与会话级祖先链", async () => {
  const { buildSidebarTree, locateSessionInSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const parent = session("p", { cwd: "/repo", projectRoot: "/repo" });
  const child = session("c", { cwd: "/repo", projectRoot: "/repo", parentSessionId: "p" });
  const wtParent = session("wp", { cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat" });
  const wtGrand = session("wg", {
    cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat",
    parentSessionId: "wp",
  });
  const tree = buildSidebarTree([parent, child, wtParent, wtGrand]);
  assert.deepEqual(locateSessionInSidebarTree(tree, "p"), { projectRoot: "/repo", worktreePath: null, ancestors: [] });
  assert.deepEqual(locateSessionInSidebarTree(tree, "c"), { projectRoot: "/repo", worktreePath: null, ancestors: ["p"] });
  assert.deepEqual(locateSessionInSidebarTree(tree, "wg"), { projectRoot: "/repo", worktreePath: "/repo-worktrees/feat", ancestors: ["wp"] });
  assert.equal(locateSessionInSidebarTree(tree, "missing"), null);
});

test("搜索与折叠偏好隔离：过滤不触碰折叠集合，搜索期强制展开只读不写", async () => {
  const { buildSidebarTree, filterSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const { isSessionNodeEffectivelyCollapsed } = await jiti.import("./session-tree.ts");
  const main = session("m", { cwd: "/repo", projectRoot: "/repo", name: "hit me" });
  const tree = buildSidebarTree([main]);
  const collapsedProjects = new Set(["/repo"]);
  const collapsedWorktrees = new Set(["/repo-worktrees/feat"]);
  // 搜索过滤是纯函数：两个折叠集合原样不动。
  const filtered = filterSidebarTree(tree, "hit");
  assert.equal(filtered.length, 1);
  assert.deepEqual([...collapsedProjects], ["/repo"]);
  assert.deepEqual([...collapsedWorktrees], ["/repo-worktrees/feat"]);
  // 搜索期间渲染层强制展开（对项目/worktree 复用同一判定），集合不被改写。
  assert.equal(isSessionNodeEffectivelyCollapsed(collapsedProjects, "/repo", true), false);
  assert.equal(isSessionNodeEffectivelyCollapsed(collapsedWorktrees, "/repo-worktrees/feat", true), false);
  assert.equal(isSessionNodeEffectivelyCollapsed(collapsedProjects, "/repo", false), true);
  assert.deepEqual([...collapsedProjects], ["/repo"]);
});
