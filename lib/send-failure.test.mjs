/**
 * P0-1：发送失败恢复决策纯函数测试。
 * 覆盖「首条 prompt 失败时 draft 保留 + 假 bubble 移除」的核心判定。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { recoverFailedSend } = await jiti.import("./send-failure.ts");

/** @type {(content: string) => import("./types").AgentMessage} */
function userMsg(content) {
  return { role: "user", content, timestamp: Date.now() };
}

test("recoverFailedSend：失败时移除末尾假 bubble 并标记恢复 draft", () => {
  const optimistic = userMsg("hi");
  const previous = userMsg("prev");
  const recovery = recoverFailedSend({
    messages: [previous, optimistic],
    optimisticKey: "key-hi",
    isOptimisticMatch: (m) => m === optimistic,
  });
  assert.deepEqual(recovery.messages, [previous]);
  assert.equal(recovery.restoreDraft, true);
  assert.equal(recovery.optimisticKey, null);
});

test("recoverFailedSend：bubble 已被 message_end 消费（末尾不匹配）→ 保持列表且不恢复 draft", () => {
  const messages = [userMsg("other")];
  const recovery = recoverFailedSend({
    messages,
    optimisticKey: "key-hi",
    isOptimisticMatch: (m) => m.content === "hi",
  });
  assert.equal(recovery.messages.length, 1);
  assert.equal(recovery.restoreDraft, false);
});

test("recoverFailedSend：optimisticKey 为 null（从未设置/已消费）→ 不做任何变更", () => {
  const messages = [userMsg("hi")];
  const recovery = recoverFailedSend({
    messages,
    optimisticKey: null,
    isOptimisticMatch: () => true,
  });
  assert.equal(recovery.messages.length, 1);
  assert.equal(recovery.restoreDraft, false);
});

test("recoverFailedSend：中间插入其它消息时不移除（只动末尾相邻 bubble）", () => {
  const optimistic = userMsg("hi");
  const inserted = userMsg("queued");
  const recovery = recoverFailedSend({
    messages: [optimistic, inserted],
    optimisticKey: "key-hi",
    isOptimisticMatch: (m) => m === optimistic,
  });
  assert.equal(recovery.messages.length, 2);
  assert.equal(recovery.restoreDraft, false);
});

test("recoverFailedSend：空列表安全（不移除、不恢复）", () => {
  const recovery = recoverFailedSend({
    messages: [],
    optimisticKey: "key-hi",
    isOptimisticMatch: () => true,
  });
  assert.deepEqual(recovery.messages, []);
  assert.equal(recovery.restoreDraft, false);
});
