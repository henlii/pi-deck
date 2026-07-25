import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { applyExtensionUiRequest } = await jiti.import("./extension-ui-bridge.ts");

const base = { dialog: null, customUi: null, statuses: [], widgets: [] };
const request = (method, fields = {}) => ({ type: "extension_ui_request", id: method, method, ...fields });

test("四种对话请求都会替换 dialog", () => {
  for (const method of ["select", "confirm", "input", "editor"]) {
    const result = applyExtensionUiRequest(base, request(method, { title: "请求" }));
    assert.equal(result.state.dialog.method, method);
    assert.deepEqual(result.effects, []);
  }
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
