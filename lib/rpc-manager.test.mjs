import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  parseNavigateTreeCommand,
  parseSetBranchLabelCommand,
  BRANCH_LABEL_MAX_LENGTH,
} = await jiti.import("./rpc-manager.ts");

test("RPC session startup preloads extension-registered providers before restoring models", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /createAgentSessionServices\(/);
  assert.match(startupSource, /createAgentSessionFromServices\(/);
  assert.doesNotMatch(startupSource, /await createAgentSession\(/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("parseNavigateTreeCommand 透传 summarize 与 trim 后的 customInstructions / targetId", () => {
  assert.deepEqual(
    parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "  entry-1  ",
      summarize: true,
      customInstructions: "  关注 diff  ",
    }),
    {
      targetId: "entry-1",
      summarize: true,
      customInstructions: "关注 diff",
    },
  );

  assert.deepEqual(
    parseNavigateTreeCommand({ type: "navigate_tree", targetId: "e2" }),
    { targetId: "e2" },
  );

  // 仅空白的 customInstructions 不透传
  assert.deepEqual(
    parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "e3",
      customInstructions: "   ",
    }),
    { targetId: "e3" },
  );
});

test("parseNavigateTreeCommand 拒绝非法参数与客户端 replaceInstructions", () => {
  assert.throws(
    () => parseNavigateTreeCommand({ type: "navigate_tree" }),
    /targetId is required/,
  );
  assert.throws(
    () => parseNavigateTreeCommand({ type: "navigate_tree", targetId: "  " }),
    /targetId is required/,
  );
  assert.throws(
    () => parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "e1",
      replaceInstructions: true,
    }),
    /replaceInstructions is not allowed/,
  );
  assert.throws(
    () => parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "e1",
      summarize: "yes",
    }),
    /summarize must be a boolean/,
  );
  assert.throws(
    () => parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "e1",
      customInstructions: 12,
    }),
    /customInstructions must be a string/,
  );
});

test("parseSetBranchLabelCommand 支持 set / clear，超长拒绝，targetId 已 trim", () => {
  assert.deepEqual(
    parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "  n1  ", label: "  书签A  " }),
    { targetId: "n1", label: "书签A" },
  );

  // trim 后空 → 清除
  assert.deepEqual(
    parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: "   " }),
    { targetId: "n1", label: undefined },
  );
  assert.deepEqual(
    parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: undefined }),
    { targetId: "n1", label: undefined },
  );

  assert.throws(
    () => parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: "x".repeat(BRANCH_LABEL_MAX_LENGTH + 1) }),
    /maximum length/,
  );
  assert.throws(
    () => parseSetBranchLabelCommand({ type: "set_branch_label", label: "ok" }),
    /targetId is required/,
  );
  assert.throws(
    () => parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1" }),
    /label is required/,
  );
  assert.throws(
    () => parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: 1 }),
    /label must be a string/,
  );

  // 边界：恰好最大长度可接受
  const max = "y".repeat(BRANCH_LABEL_MAX_LENGTH);
  assert.deepEqual(
    parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: max }),
    { targetId: "n1", label: max },
  );
});

test("navigate_tree / set_branch_label 命令 seam 存在于 send 分发", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /case "navigate_tree"/);
  assert.match(source, /parseNavigateTreeCommand\(command\)/);
  assert.match(source, /case "set_branch_label"/);
  assert.match(source, /appendLabelChange\(targetId, label\)/);
  assert.match(source, /invalidateSessionListCache\(\)/);
  // 返回完整 SDK 结果，不只 cancelled
  const navCase = source.slice(
    source.indexOf('case "navigate_tree"'),
    source.indexOf('case "set_branch_label"'),
  );
  assert.match(navCase, /return result;/);
  assert.doesNotMatch(navCase, /return \{ cancelled: result\.cancelled \}/);
});
