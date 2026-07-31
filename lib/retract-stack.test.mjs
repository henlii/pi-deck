import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

const {
	computeChainTail,
	extractUserText,
	isDescendantOrSelf,
	isOnLeafChain,
	pushRetracted,
	removeRetracted,
	RETRACT_PREVIEW_MAX,
} = await jiti.import("./retract-stack.ts");

/** 串行链：u1 → a1 → u2 → a2 → u3 → a3 */
function serialChain() {
	return [
		{ id: "u1", parentId: null },
		{ id: "a1", parentId: "u1" },
		{ id: "u2", parentId: "a1" },
		{ id: "a2", parentId: "u2" },
		{ id: "u3", parentId: "a2" },
		{ id: "a3", parentId: "u3" },
	];
}

test("computeChainTail 沿第一个孩子链走到最深末端", () => {
	const entries = serialChain();
	assert.equal(computeChainTail(entries, "u1"), "a3");
	assert.equal(computeChainTail(entries, "u2"), "a3");
	assert.equal(computeChainTail(entries, "a2"), "a3");
	// 叶子：返回自身
	assert.equal(computeChainTail(entries, "a3"), "a3");
	// 并行分支：取文件序第一个孩子
	const branch = [
		{ id: "u1", parentId: null },
		{ id: "a1x", parentId: "u1" },
		{ id: "a1y", parentId: "u1" },
	];
	assert.equal(computeChainTail(branch, "u1"), "a1x");
	// 不存在
	assert.equal(computeChainTail(entries, "nope"), null);
});

test("isDescendantOrSelf / isOnLeafChain", () => {
	const entries = serialChain();
	assert.equal(isDescendantOrSelf(entries, "a3", "u1"), true);
	assert.equal(isDescendantOrSelf(entries, "u1", "u1"), true);
	assert.equal(isDescendantOrSelf(entries, "a1", "u2"), false);
	assert.equal(isOnLeafChain(entries, "a3", "u2"), true);
	assert.equal(isOnLeafChain(entries, "a1", "u2"), false);
	assert.equal(isOnLeafChain(entries, null, "u2"), false);
});

test("extractUserText 提取纯文本并截断", () => {
	assert.equal(extractUserText({ role: "user", content: "hello" }), "hello");
	assert.equal(
		extractUserText({
			role: "user",
			content: [
				{ type: "text", text: "  a " },
				{ type: "image", data: "x" },
				{ type: "text", text: " b " },
			],
		}),
		"a b",
	);
	assert.equal(extractUserText({ role: "assistant", content: "x" }), "");
	assert.equal(extractUserText(null), "");
	const long = "x".repeat(RETRACT_PREVIEW_MAX + 50);
	const out = extractUserText({ role: "user", content: long });
	assert.ok(out.endsWith("…"));
	assert.ok(out.length <= RETRACT_PREVIEW_MAX + 1);
});

function rec(entryId, chainTailEntryId) {
	return { entryId, text: entryId, chainTailEntryId };
}

test("pushRetracted 幂等去重", () => {
	const s1 = pushRetracted([], rec("m1", "t1"));
	assert.deepEqual(
		s1.map((r) => r.entryId),
		["m1"],
	);
	const s2 = pushRetracted(s1, rec("m1", "t1"));
	assert.equal(s2.length, 1, "重复 entryId 不重复入栈");
	const s3 = pushRetracted(s2, rec("m2", "t2"));
	assert.deepEqual(
		s3.map((r) => r.entryId),
		["m1", "m2"],
	);
	assert.equal(s1.length, 1, "原栈不被修改");
});

test("removeRetracted 移除目标及其子孙链记录，并行兄弟保留", () => {
	// u1 → a1 → u2 → a2 → u3 → a3（串行重发链）
	const entries = serialChain();
	const stack = [rec("u1", "a3"), rec("u2", "a3"), rec("u3", "a3")];
	// 恢复 u2：u2 及子孙（u3）移出，u1 保留
	const after = removeRetracted(entries, stack, "u2");
	assert.deepEqual(
		after.map((r) => r.entryId),
		["u1"],
	);

	// 并行分支：恢复 u2 不触碰并行分支 u1
	const parallel = [
		{ id: "u1", parentId: null },
		{ id: "a1x", parentId: "u1" },
		{ id: "u2", parentId: "a1x" },
		{ id: "a1y", parentId: "u1" },
		{ id: "u3", parentId: "a1y" },
	];
	const ps = [rec("u1", "a1y"), rec("u2", "a2")];
	const pa = removeRetracted(parallel, ps, "u1");
	assert.deepEqual(
		pa.map((r) => r.entryId),
		[],
		"u1 的子孙全部移出",
	);
	const pa2 = removeRetracted(parallel, ps, "u2");
	assert.deepEqual(
		pa2.map((r) => r.entryId),
		["u1"],
	);
});
