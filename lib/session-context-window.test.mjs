import test from "node:test";
import assert from "node:assert/strict";
import {
  sliceContextTail,
  sliceContextBefore,
  mergeTailReload,
  prependOlderPage,
  parseContextLimitParam,
  DEFAULT_SESSION_TAIL_LIMIT,
} from "./session-context-window.ts";

function ctx(n) {
  const messages = [];
  const entryIds = [];
  for (let i = 0; i < n; i++) {
    entryIds.push(`e${i}`);
    messages.push({ role: "user", content: `m${i}` });
  }
  return {
    messages,
    entryIds,
    thinkingLevel: "auto",
    model: { provider: "p", modelId: "m" },
  };
}

test("sliceContextTail：不足 limit 时 hasMoreBefore=false", () => {
  const w = sliceContextTail(ctx(10), 80);
  assert.equal(w.messages.length, 10);
  assert.equal(w.hasMoreBefore, false);
  assert.equal(w.totalMessageCount, 10);
});

test("sliceContextTail：截取最新 limit 条", () => {
  const w = sliceContextTail(ctx(100), 20);
  assert.equal(w.messages.length, 20);
  assert.equal(w.entryIds[0], "e80");
  assert.equal(w.entryIds[19], "e99");
  assert.equal(w.hasMoreBefore, true);
  assert.equal(w.totalMessageCount, 100);
  assert.equal(w.thinkingLevel, "auto");
});

test("sliceContextBefore：取 before 之前的窗口", () => {
  const w = sliceContextBefore(ctx(100), "e80", 20);
  assert.equal(w.entryIds[0], "e60");
  assert.equal(w.entryIds[19], "e79");
  assert.equal(w.hasMoreBefore, true);
  assert.equal(w.totalMessageCount, 100);
});

test("sliceContextBefore：before 为第一项时返回空", () => {
  const w = sliceContextBefore(ctx(10), "e0", 5);
  assert.deepEqual(w.entryIds, []);
  assert.equal(w.hasMoreBefore, false);
});

test("mergeTailReload：保留更旧前缀并替换尾部", () => {
  const prevIds = ["a", "b", "c", "d", "e"];
  const prevMsgs = prevIds.map((id) => ({ role: "user", content: id }));
  const nextIds = ["c", "d", "e", "f"];
  const nextMsgs = nextIds.map((id) => ({ role: "user", content: `${id}-new` }));
  const m = mergeTailReload({
    previousMessages: prevMsgs,
    previousEntryIds: prevIds,
    nextMessages: nextMsgs,
    nextEntryIds: nextIds,
  });
  assert.deepEqual(m.entryIds, ["a", "b", "c", "d", "e", "f"]);
  assert.equal(m.messages[0].content, "a");
  assert.equal(m.messages[2].content, "c-new");
  assert.equal(m.messages[5].content, "f-new");
});

test("prependOlderPage：边界去重", () => {
  const p = prependOlderPage({
    previousMessages: [{ role: "user", content: "c" }, { role: "user", content: "d" }],
    previousEntryIds: ["c", "d"],
    olderMessages: [{ role: "user", content: "a" }, { role: "user", content: "b" }, { role: "user", content: "c-old" }],
    olderEntryIds: ["a", "b", "c"],
  });
  assert.deepEqual(p.entryIds, ["a", "b", "c", "d"]);
  assert.equal(p.messages[2].content, "c");
});

test("parseContextLimitParam：limit/tail 同义，缺省 null", () => {
  assert.equal(parseContextLimitParam({ get: () => null }), null);
  assert.equal(parseContextLimitParam({ get: (k) => (k === "limit" ? "40" : null) }), 40);
  assert.equal(parseContextLimitParam({ get: (k) => (k === "tail" ? "40" : null) }), 40);
  assert.equal(parseContextLimitParam({ get: () => "bad" }), DEFAULT_SESSION_TAIL_LIMIT);
});
