import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const load = () => jiti.import("./chat-compositor.ts");

const assistant = (content, extra = {}) => ({
  role: "assistant",
  provider: "p",
  model: "m",
  content,
  ...extra,
});
const user = (content = "q") => ({ role: "user", content });
const custom = (content = "process") => ({
  role: "custom",
  customType: "test",
  content,
  display: true,
});
const text = (value) => ({ type: "text", text: value });
const tool = (id = "c") => ({
  type: "toolCall",
  toolCallId: id,
  toolName: "bash",
  input: {},
});
const toolResult = (toolCallId = "c") => ({
  role: "toolResult",
  toolCallId,
  content: [],
});
const compose = (composeChatPlan, messages, options = {}) => composeChatPlan({
  messages,
  isStreaming: false,
  agentOrBashRunning: false,
  ...options,
});

test("空消息和单消息保持原序", async () => {
  const { composeChatPlan } = await load();

  assert.deepEqual(compose(composeChatPlan, []), []);
  const plan = compose(composeChatPlan, [user()]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].messageIndex, 0);
});

test("两个普通问答轮保持原始索引顺序", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([text("a")]), user(), assistant([text("b")])];

  const plan = compose(composeChatPlan, messages);

  assert.deepEqual(plan.map((item) => item.kind === "message"
    ? item.messageIndex
    : [item.userIdx, item.finalAssistantIdx]), [0, 1, 2, 3]);
});

test("thinking、toolCall 和 final answer 按过程分组并拆分 override", async () => {
  const { composeChatPlan } = await load();
  const usage = { input: 1 };
  const messages = [user(), assistant([
    { type: "thinking", thinking: "x" },
    tool(),
    text("answer"),
  ], { usage })];

  const plan = compose(composeChatPlan, messages);
  const group = plan[1];

  assert.equal(group.kind, "processGroup");
  assert.equal(group.messageCount, 1);
  assert.equal(group.toolCallCount, 1);
  assert.deepEqual(group.children[0].messageOverride.content.map((block) => block.type), ["thinking", "toolCall"]);
  assert.equal(group.children[0].messageOverride.usage, undefined);
  assert.equal(plan[2].messageOverride.content[0].text, "answer");
  assert.equal(plan[2].messageOverride.usage, usage);
});

test("无 final assistant 时保持原序直渲", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), toolResult(), custom()];

  const plan = compose(composeChatPlan, messages);

  assert.deepEqual(plan.map((item) => item.messageIndex), [0, 1, 2]);
});

test("两个运行标量分别独立触发 live tail", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([text("live")])];

  for (const options of [
    { agentOrBashRunning: true, isStreaming: false },
    { agentOrBashRunning: false, isStreaming: true },
  ]) {
    const plan = compose(composeChatPlan, messages, options);

    assert.deepEqual(plan.map((item) => item.messageIndex), [0, 1]);
    assert.equal(plan.some((item) => item.kind === "processGroup"), false);
  }
});

test("live tail 的末尾 assistant 隐藏 timestamp", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([text("live")])];

  const plan = compose(composeChatPlan, messages, { isStreaming: true });

  assert.equal(plan[1].showTimestamp, false);
});

test("非 live tail 会分组过程消息", async () => {
  const { composeChatPlan } = await load();
  const messages = [
    user(),
    assistant([{ type: "thinking", thinking: "work" }, tool(), text("answer")]),
  ];

  const plan = compose(composeChatPlan, messages);

  assert.equal(plan[1].kind, "processGroup");
  assert.equal(plan[1].finalAssistantIdx, 1);
});

test("process group 无 answer 时 ref 回退到 finalAssistantIdx", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([
    { type: "thinking", thinking: "still working" },
    tool(),
  ])];

  const plan = compose(composeChatPlan, messages);
  const group = plan[1];

  assert.equal(group.kind, "processGroup");
  assert.equal(group.attachRefMessageIndex, 1);
});

test("custom process 有 final answer 时不附加 process ref", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), custom(), assistant([text("answer")])];

  const plan = compose(composeChatPlan, messages);
  const group = plan[1];

  assert.equal(group.kind, "processGroup");
  assert.equal(group.attachRefMessageIndex, undefined);
  assert.equal(group.messageCount, 1);
  assert.equal(group.toolCallCount, 0);
});

test("普通过程子项使用 process key 且不附加 ref", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([
    { type: "thinking", thinking: "work" },
    tool(),
  ]), assistant([text("answer")])];

  const plan = compose(composeChatPlan, messages);
  const group = plan[1];
  const child = group.children[0];

  assert.equal(child.keyPrefix, "process");
  assert.equal(child.attachRef, false);
  assert.equal(group.messageCount, 1);
  assert.equal(group.toolCallCount, 1);
});

test("user、answer、toolResult、user 的尾随索引保持原序", async () => {
  const { composeChatPlan } = await load();
  const messages = [user("first"), assistant([text("answer")]), toolResult(), user("second")];

  const plan = compose(composeChatPlan, messages);

  assert.deepEqual(plan.map((item) => item.messageIndex), [0, 1, 2, 3]);
});

test("相邻 assistant 只显示最后一个 timestamp", async () => {
  const { composeChatPlan } = await load();
  const messages = [assistant([text("a")]), assistant([text("b")]), user(), assistant([text("c")])];

  const plan = compose(composeChatPlan, messages);

  assert.equal(plan[0].showTimestamp, false);
  assert.equal(plan[1].showTimestamp, true);
  assert.equal(plan[3].showTimestamp, true);
});

test("不变异输入并保留 answer usage", async () => {
  const { composeChatPlan } = await load();
  const usage = { input: 2 };
  const messages = [user(), assistant([tool(), text("a")], { usage })];
  const before = structuredClone(messages);

  const plan = compose(composeChatPlan, messages);

  assert.deepEqual(messages, before);
  assert.equal(plan[1].children[0].messageOverride.usage, undefined);
  assert.equal(plan[2].messageOverride.usage, usage);
});
