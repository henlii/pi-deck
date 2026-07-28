import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  BRANCH_LABEL_MAX_LENGTH,
  normalizeBranchLabelInput,
  buildSetBranchLabelCommand,
  buildBranchSwitchCommand,
  getBranchNodeBookmark,
  canCompressChainNode,
  treeHasBookmarks,
  findBranchLabelByEntryId,
  gateBranchAction,
  getBranchSummaryFileMetadata,
} = await jiti.import("./branch-bookmarks.ts");

const treeNode = (id, { label, children = [], compressed } = {}) => ({
  entry: { type: "message", id, parentId: null, timestamp: "2026-07-27T00:00:00Z" },
  children,
  ...(label !== undefined ? { label } : {}),
  ...(compressed ? { compressedEntryIds: compressed } : {}),
});

test("normalizeBranchLabelInput：trim、空为清除、超长拒绝、边界恰好 120 可用", () => {
  assert.deepEqual(normalizeBranchLabelInput("  设计评审  "), { kind: "set", label: "设计评审" });
  assert.deepEqual(normalizeBranchLabelInput(""), { kind: "clear" });
  assert.deepEqual(normalizeBranchLabelInput("   "), { kind: "clear" });
  assert.deepEqual(normalizeBranchLabelInput(undefined), { kind: "clear" });
  assert.deepEqual(normalizeBranchLabelInput(null), { kind: "clear" });

  const max = "书".repeat(BRANCH_LABEL_MAX_LENGTH);
  assert.deepEqual(normalizeBranchLabelInput(max), { kind: "set", label: max });
  assert.deepEqual(
    normalizeBranchLabelInput(`${max}x`),
    { kind: "tooLong", maxLength: BRANCH_LABEL_MAX_LENGTH },
  );
  // trim 后超长同样拒绝
  assert.deepEqual(
    normalizeBranchLabelInput(`  ${max}x  `),
    { kind: "tooLong", maxLength: BRANCH_LABEL_MAX_LENGTH },
  );
});

test("buildSetBranchLabelCommand：set/clear 构造，清除的空串经 JSON 往返仍保留 label 键", () => {
  assert.deepEqual(buildSetBranchLabelCommand("n1", "  书签A  "), {
    type: "set_branch_label",
    targetId: "n1",
    label: "书签A",
  });

  // 清除发空串：JSON 序列化会丢弃 undefined，后端拒绝 null，空串是唯一安全载体
  const clearCmd = buildSetBranchLabelCommand("n1", "   ");
  assert.deepEqual(clearCmd, { type: "set_branch_label", targetId: "n1", label: "" });
  const roundTripped = JSON.parse(JSON.stringify(clearCmd));
  assert.equal("label" in roundTripped, true);
  assert.equal(roundTripped.label, "");

  assert.equal(buildSetBranchLabelCommand("n1", "x".repeat(BRANCH_LABEL_MAX_LENGTH + 1)), null);
});

test("buildBranchSwitchCommand：三种模式构造与自定义焦点门禁", () => {
  assert.deepEqual(buildBranchSwitchCommand("t1", { mode: "direct" }), {
    type: "navigate_tree",
    targetId: "t1",
    summarize: false,
  });
  assert.deepEqual(buildBranchSwitchCommand("t2", { mode: "summary" }), {
    type: "navigate_tree",
    targetId: "t2",
    summarize: true,
  });
  assert.deepEqual(buildBranchSwitchCommand("t3", { mode: "custom", focus: "  保留 diff 结论  " }), {
    type: "navigate_tree",
    targetId: "t3",
    summarize: true,
    customInstructions: "保留 diff 结论",
  });
  // 自定义焦点必须非空
  assert.equal(buildBranchSwitchCommand("t4", { mode: "custom", focus: "" }), null);
  assert.equal(buildBranchSwitchCommand("t4", { mode: "custom", focus: "   " }), null);
});

test("getBranchNodeBookmark：label 优先、trim、空白回退 null", () => {
  assert.equal(getBranchNodeBookmark("  里程碑  "), "里程碑");
  assert.equal(getBranchNodeBookmark(undefined), null);
  assert.equal(getBranchNodeBookmark(null), null);
  assert.equal(getBranchNodeBookmark(""), null);
  assert.equal(getBranchNodeBookmark("   "), null);
});

test("canCompressChainNode / treeHasBookmarks：带书签节点不被压缩且可被探测", () => {
  assert.equal(canCompressChainNode({}), true);
  assert.equal(canCompressChainNode({ label: "  " }), true);
  assert.equal(canCompressChainNode({ label: "锚点" }), false);

  const bare = [treeNode("a", { children: [treeNode("b")] })];
  assert.equal(treeHasBookmarks(bare), false);
  const withBookmark = [treeNode("a", { children: [treeNode("b", { label: "锚点" })] })];
  assert.equal(treeHasBookmarks(withBookmark), true);
});

test("findBranchLabelByEntryId：命中自身与被压缩 id，未命中返回 null", () => {
  const tree = [
    treeNode("root", {
      children: [
        treeNode("mid", {
          compressed: ["hidden-1", "hidden-2"],
          children: [treeNode("leaf", { label: "  终点  " })],
        }),
      ],
    }),
  ];
  assert.equal(findBranchLabelByEntryId(tree, "leaf"), "终点");
  assert.equal(findBranchLabelByEntryId(tree, "hidden-2"), null);
  assert.equal(findBranchLabelByEntryId(tree, "missing"), null);
  assert.equal(findBranchLabelByEntryId(tree, null), null);
  assert.equal(findBranchLabelByEntryId(tree, undefined), null);

  const compressedBookmark = [
    treeNode("root", {
      children: [treeNode("rep", { label: "锚点", compressed: ["hidden-9"] })],
    }),
  ];
  assert.equal(findBranchLabelByEntryId(compressedBookmark, "hidden-9"), "锚点");
});

test("gateBranchAction：只读与进行中都拒绝，空闲可写放行", () => {
  assert.deepEqual(gateBranchAction({ readOnly: true, busy: false }), { allowed: false, reason: "readOnly" });
  assert.deepEqual(gateBranchAction({ readOnly: true, busy: true }), { allowed: false, reason: "readOnly" });
  assert.deepEqual(gateBranchAction({ readOnly: false, busy: true }), { allowed: false, reason: "busy" });
  assert.deepEqual(gateBranchAction({ readOnly: false, busy: false }), { allowed: true });
});

test("getBranchSummaryFileMetadata：嵌套 details 提取与异形降级", () => {
  assert.deepEqual(
    getBranchSummaryFileMetadata({
      fromId: "abc12345",
      details: { readFiles: ["a.ts", "b.ts"], modifiedFiles: ["c.ts"] },
      usage: { totalTokens: 100 },
      fromHook: false,
    }),
    { readFiles: ["a.ts", "b.ts"], modifiedFiles: ["c.ts"] },
  );

  // 非字符串项被过滤
  assert.deepEqual(
    getBranchSummaryFileMetadata({ details: { readFiles: ["a.ts", 1, null], modifiedFiles: [] } }),
    { readFiles: ["a.ts"], modifiedFiles: [] },
  );

  assert.equal(getBranchSummaryFileMetadata(undefined), null);
  assert.equal(getBranchSummaryFileMetadata(null), null);
  assert.equal(getBranchSummaryFileMetadata("x"), null);
  assert.equal(getBranchSummaryFileMetadata({}), null);
  assert.equal(getBranchSummaryFileMetadata({ details: null }), null);
  assert.equal(getBranchSummaryFileMetadata({ details: { readFiles: "not-array" } }), null);
  assert.equal(getBranchSummaryFileMetadata({ details: { readFiles: [], modifiedFiles: [] } }), null);
});
