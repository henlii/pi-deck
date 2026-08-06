import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildActiveBranchPath } = await jiti.import("./session-branch-path.ts");

function entry(id, parentId) {
  return {
    id,
    parentId,
    type: "custom",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

test("从 leaf 沿 parentId 上溯并 reverse 为 root→leaf", () => {
  const entries = [
    entry("u1", null),
    entry("a1", "u1"),
    entry("a2", "a1"),
    entry("b1", "u1"),
  ];
  assert.deepEqual(
    buildActiveBranchPath(entries, "a2").map((e) => e.id),
    ["u1", "a1", "a2"],
  );
  assert.deepEqual(
    buildActiveBranchPath(entries, "b1").map((e) => e.id),
    ["u1", "b1"],
  );
});

test("leaf 为 null / 找不到 → 原始顺序全量", () => {
  const entries = [entry("u1", null), entry("a1", "u1")];
  assert.deepEqual(buildActiveBranchPath(entries, null).map((e) => e.id), ["u1", "a1"]);
  assert.deepEqual(buildActiveBranchPath(entries, undefined).map((e) => e.id), ["u1", "a1"]);
  assert.deepEqual(buildActiveBranchPath(entries, "missing").map((e) => e.id), ["u1", "a1"]);
  assert.deepEqual(buildActiveBranchPath([], null), []);
});

test("环保护：parentId 成环时终止不陷入死循环", () => {
  const entries = [entry("a", "b"), entry("b", "a")];
  // 上溯在遇到已见节点时终止；a→b→a 环内路径为 [b, a]（root→leaf）
  const path = buildActiveBranchPath(entries, "a");
  assert.equal(path.length, 2);
  assert.deepEqual(path.map((e) => e.id), ["b", "a"]);
});

test("parentId 悬空（指向不存在的 id）→ 上溯自然终止", () => {
  const entries = [entry("a", "u1"), entry("b", "ghost")];
  assert.deepEqual(buildActiveBranchPath(entries, "b").map((e) => e.id), ["b"]);
  assert.deepEqual(buildActiveBranchPath(entries, "a").map((e) => e.id), ["a"]);
});

test("不改动入参数组", () => {
  const entries = [entry("u1", null), entry("a1", "u1")];
  const copy = [...entries];
  buildActiveBranchPath(entries, "a1");
  assert.deepEqual(entries, copy);
});
