import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  applyExtensionUiRequest,
  clearExtensionUiRequest,
  isShortSelectOptions,
} = await jiti.import("./extension-ui-bridge.ts");

const base = { dialog: null, inlineRequest: null, customUi: null, statuses: [], widgets: [] };
const request = (method, fields = {}) => ({ type: "extension_ui_request", id: method, method, ...fields });

test("confirm 和 input 进入 inlineRequest，短 select 也进入 inlineRequest", () => {
  for (const method of ["confirm", "input"]) {
    const current = request(method, { title: "请求" });
    const result = applyExtensionUiRequest(base, current);
    assert.equal(result.state.inlineRequest, current);
    assert.equal(result.state.dialog, null);
    assert.deepEqual(result.effects, []);
  }
  const current = request("select", { title: "请求", options: ["一", "二"] });
  const result = applyExtensionUiRequest(base, current);
  assert.equal(result.state.inlineRequest, current);
  assert.equal(result.state.dialog, null);
});

test("短 select 规则拒绝长列表、空选项、超长选项和超长总字符", () => {
  assert.equal(isShortSelectOptions(["一"]), true);
  assert.equal(isShortSelectOptions(Array.from({ length: 9 }, () => "选项")), false);
  assert.equal(isShortSelectOptions(["  "]), false);
  assert.equal(isShortSelectOptions(["x".repeat(81)]), false);
  assert.equal(isShortSelectOptions(["x".repeat(160), "y".repeat(161)]), false);
  const long = request("select", { options: ["x".repeat(81)] });
  const result = applyExtensionUiRequest(base, long);
  assert.equal(result.state.dialog, long);
  assert.equal(result.state.inlineRequest, null);
});

test("editor 始终进入 dialog", () => {
  const current = request("editor", { title: "编辑" });
  const result = applyExtensionUiRequest({ ...base, inlineRequest: request("confirm") }, current);
  assert.equal(result.state.dialog, current);
  assert.equal(result.state.inlineRequest, null);
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

test("新的阻塞请求会清空另一种承载", () => {
  const inline = applyExtensionUiRequest(base, request("confirm", { id: "inline" })).state;
  const dialog = applyExtensionUiRequest(inline, request("editor", { id: "dialog" })).state;
  assert.equal(dialog.inlineRequest, null);
  assert.equal(dialog.dialog.id, "dialog");
  const inlineAgain = applyExtensionUiRequest(dialog, request("input", { id: "inline-again" })).state;
  assert.equal(inlineAgain.dialog, null);
  assert.equal(inlineAgain.inlineRequest.id, "inline-again");
});

test("按 id 清理当前 inline/dialog，旧 id 不会清理新请求", () => {
  const oldInline = applyExtensionUiRequest(base, request("confirm", { id: "old" })).state;
  const newInline = applyExtensionUiRequest(oldInline, request("input", { id: "new" })).state;
  assert.equal(clearExtensionUiRequest(newInline, "old"), newInline);
  const clearedInline = clearExtensionUiRequest(newInline, "new");
  assert.equal(clearedInline.inlineRequest, null);
  const dialog = applyExtensionUiRequest(base, request("editor", { id: "dialog" })).state;
  assert.equal(clearExtensionUiRequest(dialog, "other"), dialog);
  assert.equal(clearExtensionUiRequest(dialog, "dialog").dialog, null);
});
