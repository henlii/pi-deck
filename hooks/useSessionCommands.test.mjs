/**
 * P3a：useSessionCommands 纯逻辑层（不挂 React）。
 * 覆盖：readOnly/busy 门禁、cancelled 不改输入不刷新、handleBranchHere 用
 * replaceText、user/assistant 预填差异、navigateBranch/setBranchLabel 刷新结果。
 */
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const { gateBranchAction } = await jiti.import("../lib/branch-bookmarks.ts");
const { planForkResult, applyNavigationSideEffects, finalizeBranchRefresh } =
  await jiti.import("../hooks/useSessionCommands.ts");

/** 记录调用轨迹的输入框 mock（replaceText / insertIfEmpty 语义对齐 ChatInputHandle）。 */
function createEditorMock() {
  const calls = [];
  return {
    calls,
    replaceText(text) { calls.push(["replace", text]); },
    insertIfEmpty(text) { calls.push(["insertIfEmpty", text]); },
  };
}

test("G1：readOnly 阻止写命令（reason=readOnly）", () => {
  assert.deepEqual(gateBranchAction({ readOnly: true, busy: false }), {
    allowed: false,
    reason: "readOnly",
  });
});

test("G2：busy（agent/bash/分支进行中）阻止重复命令（reason=busy）", () => {
  assert.deepEqual(gateBranchAction({ readOnly: false, busy: true }), {
    allowed: false,
    reason: "busy",
  });
  assert.deepEqual(gateBranchAction({ readOnly: false, busy: false }), { allowed: true });
});

test("C1：cancelled 不改输入、不刷新（applyNavigationSideEffects 返回 false）", () => {
  const editor = createEditorMock();
  // cancelled：即便返回了 editorText 也不许回填。
  const proceed = applyNavigationSideEffects(
    { noop: true, editorText: "should-not-fill" },
    editor,
    "replace",
  );
  assert.equal(proceed, false);
  assert.deepEqual(editor.calls, []);
});

test("B1：handleBranchHere 用 replaceText（replace 模式）", () => {
  const editor = createEditorMock();
  const proceed = applyNavigationSideEffects({ noop: false, editorText: "续写内容" }, editor, "replace");
  assert.equal(proceed, true);
  assert.deepEqual(editor.calls, [["replace", "续写内容"]]);
});

test("B2：handleBranchHere replace 模式空串也替换（对齐原 string 即 replace 语义）", () => {
  const editor = createEditorMock();
  applyNavigationSideEffects({ noop: false, editorText: "" }, editor, "replace");
  assert.deepEqual(editor.calls, [["replace", ""]]);
});

test("N1：navigateBranch insertIfEmpty 模式：非空才插入；空串跳过", () => {
  const editor = createEditorMock();
  const proceed = applyNavigationSideEffects(
    { noop: false, editorText: "从该处编辑" },
    editor,
    "insertIfEmpty",
  );
  assert.equal(proceed, true);
  assert.deepEqual(editor.calls, [["insertIfEmpty", "从该处编辑"]]);

  editor.calls.length = 0;
  applyNavigationSideEffects({ noop: false, editorText: "" }, editor, "insertIfEmpty");
  assert.deepEqual(editor.calls, []);
});

test("F1：user 新会话保留 prefill（planForkResult 带 text）", () => {
  assert.deepEqual(planForkResult({ newSessionId: "sid-new", cancelled: false }, "用户消息原文"), {
    kind: "switch-session",
    sessionId: "sid-new",
    prefill: "用户消息原文",
  });
});

test("F2：assistant 新会话不预填（planForkResult 无 prefill 键）", () => {
  assert.deepEqual(planForkResult({ newSessionId: "sid-new", cancelled: false }), {
    kind: "switch-session",
    sessionId: "sid-new",
  });
  assert.equal("prefill" in planForkResult({ newSessionId: "sid-new" }), false);
});

test("F3：fork cancelled / 缺失 newSessionId 保持当前会话（noop）", () => {
  assert.deepEqual(planForkResult({ cancelled: true, newSessionId: "sid-x" }, "文本"), { kind: "noop" });
  assert.deepEqual(planForkResult({}), { kind: "noop" });
  assert.deepEqual(planForkResult(null), { kind: "noop" });
});

test("R1：navigateBranch 成功刷新 context → ok；刷新失败 → error（带文案）", () => {
  assert.deepEqual(finalizeBranchRefresh(true, "Failed to refresh session after switching branches"), {
    kind: "ok",
  });
  assert.deepEqual(
    finalizeBranchRefresh(false, "Failed to refresh session after switching branches"),
    { kind: "error", message: "Failed to refresh session after switching branches" },
  );
});

test("R2：setBranchLabel 成功刷新 → ok；失败 → error（带文案）", () => {
  assert.deepEqual(finalizeBranchRefresh(true, "Failed to refresh session after saving the bookmark"), {
    kind: "ok",
  });
  assert.deepEqual(
    finalizeBranchRefresh(false, "Failed to refresh session after saving the bookmark"),
    { kind: "error", message: "Failed to refresh session after saving the bookmark" },
  );
});
