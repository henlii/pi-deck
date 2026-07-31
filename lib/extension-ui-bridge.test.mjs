import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  applyExtensionUiRequest,
  clearAllExtensionUiBlocking,
  clearExtensionUiRequest,
  createEmptyExtensionUiState,
  isShortSelectOptions,
  projectBlockingHead,
} = await jiti.import("./extension-ui-bridge.ts");

const base = createEmptyExtensionUiState();
const request = (method, fields = {}) => ({ type: "extension_ui_request", id: method, method, ...fields });

test("confirm 和 input 进入 inlineRequest，短 select 也进入 inlineRequest", () => {
  for (const method of ["confirm", "input"]) {
    const current = request(method, { title: "请求", id: method });
    const result = applyExtensionUiRequest(base, current);
    assert.equal(result.state.inlineRequest, current);
    assert.equal(result.state.dialog, null);
    assert.equal(result.state.blockingQueue.length, 1);
    assert.deepEqual(result.effects, []);
  }
  const current = request("select", { title: "请求", options: ["一", "二"], id: "short-select" });
  const result = applyExtensionUiRequest(base, current);
  assert.equal(result.state.inlineRequest, current);
  assert.equal(result.state.dialog, null);
});

test("isShortSelectOptions 仍按长短分类；长 select 也走 inline（全内联）", () => {
  assert.equal(isShortSelectOptions(["一"]), true);
  assert.equal(isShortSelectOptions(Array.from({ length: 9 }, () => "选项")), false);
  assert.equal(isShortSelectOptions(["  "]), false);
  assert.equal(isShortSelectOptions(["x".repeat(81)]), false);
  assert.equal(isShortSelectOptions(["x".repeat(160), "y".repeat(161)]), false);
  const long = request("select", { options: ["x".repeat(81)], id: "long-select" });
  const result = applyExtensionUiRequest(base, long);
  assert.equal(result.state.dialog, null);
  assert.equal(result.state.inlineRequest, long);
});

test("editor 进入 inline 投影（OpenChamber 风格全内联）", () => {
  const current = request("editor", { title: "编辑", id: "editor-1" });
  const result = applyExtensionUiRequest(base, current);
  assert.equal(result.state.dialog, null);
  assert.equal(result.state.inlineRequest, current);
  assert.equal(result.state.blockingQueue[0], current);
});

test("notify 只产生 notice effect，并保持状态引用", () => {
  const result = applyExtensionUiRequest(base, request("notify", { message: "提示", notifyType: "warning" }));
  assert.equal(result.state, base);
  assert.deepEqual(result.effects, [{ type: "notice", id: "notify", message: "提示", noticeType: "warning" }]);
  assert.deepEqual(
    applyExtensionUiRequest(base, request("notify", { message: "默认提示" })).effects,
    [{ type: "notice", id: "notify", message: "默认提示", noticeType: "info" }],
  );
});

test("status 支持替换、删除以及无变化时保持引用", () => {
  const state = { ...base, statuses: [{ key: "a", text: "旧" }, { key: "b", text: "保留" }] };
  const updated = applyExtensionUiRequest(state, request("setStatus", { statusKey: "a", statusText: "新" }));
  assert.deepEqual(updated.state.statuses, [{ key: "b", text: "保留" }, { key: "a", text: "新" }]);
  assert.equal(applyExtensionUiRequest(state, request("setStatus", { statusKey: "missing" })).state, state);
  assert.deepEqual(
    applyExtensionUiRequest(updated.state, request("setStatus", { statusKey: "a" })).state.statuses,
    [{ key: "b", text: "保留" }],
  );
});

test("widget 支持默认位置、替换和删除", () => {
  const state = { ...base, widgets: [{ key: "x", lines: ["保留"], placement: "aboveEditor" }] };
  const added = applyExtensionUiRequest(state, request("setWidget", { widgetKey: "w", widgetLines: ["一"] }));
  assert.deepEqual(added.state.widgets, [
    { key: "x", lines: ["保留"], placement: "aboveEditor" },
    { key: "w", lines: ["一"], placement: "aboveEditor" },
  ]);
  const changed = applyExtensionUiRequest(added.state, request("setWidget", { widgetKey: "w", widgetLines: ["二"], widgetPlacement: "belowEditor" }));
  assert.deepEqual(changed.state.widgets[1], { key: "w", lines: ["二"], placement: "belowEditor" });
  assert.deepEqual(applyExtensionUiRequest(changed.state, request("setWidget", { widgetKey: "w" })).state.widgets, [
    { key: "x", lines: ["保留"], placement: "aboveEditor" },
  ]);
});

test("title 和编辑器文本会产生 effect，空 title 不产生 effect", () => {
  assert.deepEqual(applyExtensionUiRequest(base, request("setTitle", { title: "标题" })).effects, [{ type: "setTitle", title: "标题" }]);
  assert.deepEqual(applyExtensionUiRequest(base, request("setTitle", { title: "" })).effects, []);
  assert.deepEqual(applyExtensionUiRequest(base, request("set_editor_text", { text: "内容" })).effects, [{ type: "insertText", text: "内容" }]);
});

test("custom 关闭时只清除匹配的当前请求", () => {
  const opened = applyExtensionUiRequest(base, request("custom", { lines: ["内容"] }));
  assert.equal(opened.state.customUi.lines[0], "内容");
  assert.equal(applyExtensionUiRequest(opened.state, request("custom", { id: "other", closed: true })).state, opened.state);
  assert.equal(applyExtensionUiRequest(opened.state, request("custom", { closed: true })).state.customUi, null);
});

// ── FIFO 阻塞队列 ──────────────────────────────────────────────────────────

test("FIFO：inline → inline 只投影队首，后续不覆盖", () => {
  const a = request("confirm", { title: "A", id: "a" });
  const b = request("input", { title: "B", id: "b" });
  let state = applyExtensionUiRequest(base, a).state;
  state = applyExtensionUiRequest(state, b).state;
  assert.equal(state.inlineRequest?.id, "a");
  assert.equal(state.dialog, null);
  assert.deepEqual(state.blockingQueue.map((item) => item.id), ["a", "b"]);
});

test("FIFO：inline → dialog 后续入队，队首仍为 inline", () => {
  const inline = request("confirm", { title: "确认", id: "inline" });
  const dialog = request("editor", { title: "编辑", id: "dialog" });
  let state = applyExtensionUiRequest(base, inline).state;
  state = applyExtensionUiRequest(state, dialog).state;
  assert.equal(state.inlineRequest?.id, "inline");
  assert.equal(state.dialog, null);
  assert.deepEqual(state.blockingQueue.map((item) => item.id), ["inline", "dialog"]);
});

test("FIFO：editor → input 后续入队，队首仍为 inline", () => {
  const first = request("editor", { title: "编辑", id: "first" });
  const second = request("input", { title: "输入", id: "second" });
  let state = applyExtensionUiRequest(base, first).state;
  state = applyExtensionUiRequest(state, second).state;
  assert.equal(state.dialog, null);
  assert.equal(state.inlineRequest?.id, "first");
  assert.deepEqual(state.blockingQueue.map((item) => item.id), ["first", "second"]);
});

test("清队首推进：移除后自动投影下一项（inline→inline）", () => {
  const a = request("confirm", { title: "A", id: "a" });
  const b = request("editor", { title: "B", id: "b" });
  let state = applyExtensionUiRequest(base, a).state;
  state = applyExtensionUiRequest(state, b).state;
  state = clearExtensionUiRequest(state, "a");
  assert.equal(state.dialog, null);
  assert.equal(state.inlineRequest?.id, "b");
  assert.deepEqual(state.blockingQueue.map((item) => item.id), ["b"]);
});

test("清非队首：不影响队首投影，但从队列移除", () => {
  const a = request("confirm", { title: "A", id: "a" });
  const b = request("input", { title: "B", id: "b" });
  const c = request("editor", { title: "C", id: "c" });
  let state = applyExtensionUiRequest(base, a).state;
  state = applyExtensionUiRequest(state, b).state;
  state = applyExtensionUiRequest(state, c).state;
  state = clearExtensionUiRequest(state, "b");
  assert.equal(state.inlineRequest?.id, "a");
  assert.equal(state.dialog, null);
  assert.deepEqual(state.blockingQueue.map((item) => item.id), ["a", "c"]);
  // 再清队首后应跳过已删的 b，投影 c（全内联：inlineRequest 承载）
  state = clearExtensionUiRequest(state, "a");
  assert.equal(state.dialog, null);
  assert.equal(state.inlineRequest?.id, "c");
});

test("重复 id 不重复入队", () => {
  const a = request("confirm", { title: "A", id: "same" });
  const again = request("confirm", { title: "A2", id: "same" });
  let state = applyExtensionUiRequest(base, a).state;
  const after = applyExtensionUiRequest(state, again);
  assert.equal(after.state, state);
  assert.equal(after.state.blockingQueue.length, 1);
  assert.equal(after.state.inlineRequest?.title, "A");
});

test("非 blocking effect 不扰乱队列", () => {
  const a = request("confirm", { title: "A", id: "a" });
  const b = request("editor", { title: "B", id: "b" });
  let state = applyExtensionUiRequest(base, a).state;
  state = applyExtensionUiRequest(state, b).state;
  const queueBefore = state.blockingQueue;
  const afterNotify = applyExtensionUiRequest(state, request("notify", { message: "提示", id: "n1" }));
  assert.equal(afterNotify.state.blockingQueue, queueBefore);
  assert.equal(afterNotify.state.inlineRequest?.id, "a");
  const afterStatus = applyExtensionUiRequest(state, request("setStatus", { statusKey: "k", statusText: "t" }));
  assert.deepEqual(afterStatus.state.blockingQueue.map((item) => item.id), ["a", "b"]);
  assert.equal(afterStatus.state.inlineRequest?.id, "a");
  const afterCustom = applyExtensionUiRequest(state, request("custom", { lines: ["x"], id: "custom-1" }));
  assert.deepEqual(afterCustom.state.blockingQueue.map((item) => item.id), ["a", "b"]);
  assert.equal(afterCustom.state.customUi?.id, "custom-1");
  assert.equal(afterCustom.state.inlineRequest?.id, "a");
});

test("全量 reset 后阻塞队列与投影为空", () => {
  let state = applyExtensionUiRequest(base, request("confirm", { id: "a" })).state;
  state = applyExtensionUiRequest(state, request("editor", { id: "b" })).state;
  state = applyExtensionUiRequest(state, request("custom", { lines: ["x"], id: "c" })).state;
  state = applyExtensionUiRequest(state, request("setStatus", { statusKey: "s", statusText: "ok" })).state;
  const cleared = clearAllExtensionUiBlocking(state);
  assert.equal(cleared.dialog, null);
  assert.equal(cleared.inlineRequest, null);
  assert.deepEqual(cleared.blockingQueue, []);
  // custom / status 保留（reset 仅清阻塞）
  assert.equal(cleared.customUi?.id, "c");
  assert.deepEqual(cleared.statuses, [{ key: "s", text: "ok" }]);
  // 二次 reset 保持引用
  assert.equal(clearAllExtensionUiBlocking(cleared), cleared);
});

test("未知 id 清理返回原引用；projectBlockingHead 空队列为空投影", () => {
  const state = applyExtensionUiRequest(base, request("confirm", { id: "a" })).state;
  assert.equal(clearExtensionUiRequest(state, "missing"), state);
  assert.deepEqual(projectBlockingHead([]), { dialog: null, inlineRequest: null });
});
