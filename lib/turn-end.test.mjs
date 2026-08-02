import { test } from "node:test";
import assert from "node:assert/strict";
import {
	computeTurnEnd,
	isUserMessageEntry,
	isAssistantMessageEntry,
} from "./turn-end.ts";

// 最小 SessionEntry fixture（结构对齐 SDK SessionEntry）
function entry(id, role, type = "message") {
	if (type !== "message") {
		return { id, parentId: null, type, timestamp: "2026-01-01T00:00:00.000Z" };
	}
	return {
		id,
		parentId: null,
		type,
		message: { role: role ?? "assistant" },
		timestamp: "2026-01-01T00:00:00.000Z",
	};
}

function chain(...ids) {
	const out = [];
	let parentId = null;
	for (const [id, kind] of ids) {
		const e =
			kind === "custom_message" || kind === "compaction"
				? entry(id, undefined, kind)
				: entry(id, kind);
		e.parentId = parentId;
		out.push(e);
		parentId = id;
	}
	return out;
}

test("computeTurnEnd: 无 tool 的简单轮次（assistant 即轮末）", () => {
	const path = chain(["u1", "user"], ["a1", "assistant"]);
	assert.equal(computeTurnEnd(path, "a1"), "a1");
});

test("computeTurnEnd: assistant(tool) → toolResult → assistant(final) 取最终 assistant", () => {
	const path = chain(
		["u1", "user"],
		["a1", "assistant"],
		["r1", "toolResult"],
		["a2", "assistant"],
	);
	assert.equal(computeTurnEnd(path, "a1"), "a2");
});

test("computeTurnEnd: 多轮 tool 循环含最终 assistant", () => {
	const path = chain(
		["u1", "user"],
		["a1", "assistant"],
		["r1", "toolResult"],
		["a2", "assistant"],
		["r2", "toolResult"],
		["a3", "assistant"],
	);
	assert.equal(computeTurnEnd(path, "a1"), "a3");
});

test("computeTurnEnd: 停在下一个 user 之前（不越轮）", () => {
	const path = chain(
		["u1", "user"],
		["a1", "assistant"],
		["r1", "toolResult"],
		["a2", "assistant"],
		["u2", "user"],
		["a3", "assistant"],
	);
	assert.equal(computeTurnEnd(path, "a1"), "a2");
	assert.equal(computeTurnEnd(path, "a3"), "a3");
});

test("computeTurnEnd: 中间 tool-call assistant 与最终 assistant 解析到同一轮末", () => {
	const path = chain(
		["u1", "user"],
		["a1", "assistant"],
		["r1", "toolResult"],
		["a2", "assistant"],
	);
	assert.equal(computeTurnEnd(path, "a1"), "a2");
	assert.equal(computeTurnEnd(path, "a2"), "a2");
});

test("computeTurnEnd: custom_message / compaction 计入轮内", () => {
	const path = chain(
		["u1", "user"],
		["a1", "assistant"],
		["r1", "toolResult"],
		["cm1", "custom_message"],
		["a2", "assistant"],
	);
	assert.equal(computeTurnEnd(path, "a1"), "a2");
	const path2 = chain(
		["u1", "user"],
		["a1", "assistant"],
		["cp1", "compaction"],
		["a2", "assistant"],
	);
	assert.equal(computeTurnEnd(path2, "a1"), "a2");
});

test("computeTurnEnd: 选中的 assistant 不在路径上 → 返回原值（调用方负责校验）", () => {
	const path = chain(["u1", "user"], ["a1", "assistant"]);
	assert.equal(computeTurnEnd(path, "ghost"), "ghost");
});

test("isUserMessageEntry / isAssistantMessageEntry", () => {
	assert.equal(isUserMessageEntry(entry("u1", "user")), true);
	assert.equal(isUserMessageEntry(entry("a1", "assistant")), false);
	assert.equal(isAssistantMessageEntry(entry("a1", "assistant")), true);
	assert.equal(isAssistantMessageEntry(entry("r1", "toolResult")), false);
});
