import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { preserveCustomRenderedLines } = await jiti.import("./custom-rendered-lines.ts");

function custom(content, renderedLines) {
	return { role: "custom", customType: "plugin.control", content, display: true, ...(renderedLines ? { renderedLines } : {}) };
}

test("custom message_end → agent_end reload 后按消息身份保留 renderedLines", () => {
	const previous = [custom("控制提示", ["\u001b[33m控制提示\u001b[0m"] )];
	const next = [custom("控制提示")];
	const merged = preserveCustomRenderedLines(previous, [], next, ["entry-1"]);
	assert.deepEqual(merged[0].renderedLines, ["\u001b[33m控制提示\u001b[0m"]);
	assert.equal(next[0].renderedLines, undefined);
});

test("entryId 优先匹配；新快照已有渲染行时不覆盖", () => {
	const previous = [custom("旧内容", ["旧渲染"]), custom("相同", ["身份渲染"])];
	const next = [custom("新内容"), custom("相同", ["服务端新渲染"])];
	const merged = preserveCustomRenderedLines(previous, ["same-id", "other"], next, ["same-id", "new"]);
	assert.deepEqual(merged[0].renderedLines, ["旧渲染"]);
	assert.deepEqual(merged[1].renderedLines, ["服务端新渲染"]);
});

test("普通消息、不同身份与非法空渲染不产生覆盖", () => {
	const previous = [custom("A", []), { role: "user", content: "hello" }];
	const next = [custom("B"), { role: "user", content: "hello" }];
	const merged = preserveCustomRenderedLines(previous, [], next, []);
	assert.equal(merged[0].renderedLines, undefined);
	assert.equal(merged[1], next[1]);
});

test("有 entryId 的旧分支消息不会按内容身份污染另一分支", () => {
	const previous = [custom("相同提示", ["旧分支渲染"])];
	const next = [custom("相同提示")];
	const merged = preserveCustomRenderedLines(previous, ["old-entry"], next, ["new-entry"]);
	assert.equal(merged[0].renderedLines, undefined);
});
