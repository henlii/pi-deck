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
    cwd: "/tmp",
    created: "2026-07-01T00:00:00.000Z",
    modified: `2026-07-0${(seq % 8) + 1}T00:00:00.000Z`,
    messageCount: 1,
    firstMessage: `msg-${id}`,
    ...overrides,
  };
}

test("fork 与 subagent 在同一父会话下同时嵌套且关系可区分", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const parent = session("p", { modified: "2026-07-09T00:00:00.000Z" });
  const fork = session("f1", { parentSessionId: "p", modified: "2026-07-08T00:00:00.000Z" });
  const sub2 = session("s2", { subagent: { parentSessionId: "p", runId: "abcd1234", runIndex: 2 }, readOnly: true });
  const sub0 = session("s0", { subagent: { parentSessionId: "p", runId: "abcd1234", runIndex: 0 }, readOnly: true });
  const roots = buildSessionDisplayTree([parent, fork, sub2, sub0]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].session.id, "p");
  assert.equal(roots[0].relation, null);
  // subagent 子会话按 runIndex 升序在前，fork 按 modified 降序在后。
  assert.deepEqual(roots[0].children.map((n) => n.session.id), ["s0", "s2", "f1"]);
  assert.deepEqual(roots[0].children.map((n) => n.relation), ["subagent", "subagent", "fork"]);
});

test("嵌套 subagent 递归挂接在各自的直接父会话下", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const parent = session("p");
  const child = session("c", { subagent: { parentSessionId: "p", runId: "r1", runIndex: 0 }, readOnly: true });
  const grandchild = session("g", { subagent: { parentSessionId: "c", runId: "r2", runIndex: 0 }, readOnly: true });
  const roots = buildSessionDisplayTree([grandchild, child, parent]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].children[0].session.id, "c");
  assert.equal(roots[0].children[0].children[0].session.id, "g");
  assert.equal(roots[0].children[0].children[0].relation, "subagent");
});

test("subagent 父会话缺失时降级为根项，不做链式上溯、不丢会话", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  // 父 "ghost" 不在集合内：即使存在同 id 的 fork 链也不允许把 subagent
  // 挂到 fork 祖先上——直接关系不伪造。
  const orphan = session("o", { subagent: { parentSessionId: "ghost", runId: "r1", runIndex: 1 }, readOnly: true });
  const other = session("x");
  const roots = buildSessionDisplayTree([orphan, other]);
  assert.equal(roots.length, 2);
  const orphanNode = roots.find((n) => n.session.id === "o");
  assert.ok(orphanNode);
  assert.equal(orphanNode.relation, null);
  assert.equal(orphanNode.children.length, 0);
});

test("fork 祖先缺失时沿链上溯到集合内最近祖先（保留原有语义）", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const grandparent = session("gp");
  // "mid" 不在集合内：f 的 fork 链 gp <- mid <- f，应直接挂到 gp。
  const fork = session("f", { parentSessionId: "mid" });
  grandparent.parentSessionId = undefined;
  const withMid = session("mid", { parentSessionId: "gp" });
  const rootsOrphanChain = buildSessionDisplayTree([grandparent, fork]);
  assert.equal(rootsOrphanChain.length, 2); // mid 缺失且 gp 与 f 无链关系 → 两个根
  const roots = buildSessionDisplayTree([grandparent, withMid, fork]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].children[0].session.id, "mid");
  assert.equal(roots[0].children[0].children[0].session.id, "f");
  assert.equal(roots[0].children[0].children[0].relation, "fork");
});

test("subagent 关系成环时相关节点全部安全降级为根项", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const a = session("a", { subagent: { parentSessionId: "b", runId: "r1", runIndex: 0 }, readOnly: true });
  const b = session("b", { subagent: { parentSessionId: "a", runId: "r2", runIndex: 0 }, readOnly: true });
  const roots = buildSessionDisplayTree([a, b]);
  assert.equal(roots.length, 2);
  assert.ok(roots.every((n) => n.relation === null && n.children.length === 0));
});

test("fork/subagent 混合环同样降级，不产生无限递归", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const a = session("a", { parentSessionId: "b" });
  const b = session("b", { subagent: { parentSessionId: "a", runId: "r1", runIndex: 0 }, readOnly: true });
  const roots = buildSessionDisplayTree([a, b]);
  assert.equal(roots.length, 2);
  assert.ok(roots.every((n) => n.relation === null));
});

test("parentSessionId 与 subagent 同时存在时以 subagent 为准", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const realParent = session("real");
  const forkParent = session("forkp");
  const both = session("both", {
    parentSessionId: "forkp",
    subagent: { parentSessionId: "real", runId: "r1", runIndex: 3, agent: "explore" },
    readOnly: true,
  });
  const roots = buildSessionDisplayTree([both, forkParent, realParent]);
  const realNode = roots.find((n) => n.session.id === "real");
  const forkNode = roots.find((n) => n.session.id === "forkp");
  assert.equal(realNode.children.length, 1);
  assert.equal(realNode.children[0].session.id, "both");
  assert.equal(realNode.children[0].relation, "subagent");
  assert.equal(forkNode.children.length, 0);
});

test("绝不修改 SessionInfo：subagent.parentSessionId 不写入 parentSessionId", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const child = session("c", {
    subagent: { parentSessionId: "p", runId: "r1", runIndex: 0 },
    readOnly: true,
  });
  const parent = session("p");
  buildSessionDisplayTree([child, parent]);
  assert.equal(child.parentSessionId, undefined);
  assert.equal(child.readOnly, true);
  assert.equal(child.subagent.parentSessionId, "p");
});

test("同层 subagent 的 run 次序按 runIndex 升序稳定排列", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const parent = session("p", { modified: "2026-07-09T00:00:00.000Z" });
  const runs = [5, 0, 3].map((runIndex, i) => session(`s${i}`, {
    subagent: { parentSessionId: "p", runId: "r1", runIndex },
    readOnly: true,
    // modified 故意与 runIndex 反序，证明排序依据是 runIndex 而非时间。
    modified: `2026-07-0${9 - runIndex}T00:00:00.000Z`,
  }));
  const roots = buildSessionDisplayTree([parent, ...runs]);
  assert.deepEqual(roots[0].children.map((n) => n.session.subagent.runIndex), [0, 3, 5]);
});
