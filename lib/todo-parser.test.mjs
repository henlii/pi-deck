import assert from "node:assert/strict";
import test from "node:test";
import { parseTodos } from "./todo-parser.ts";

const todo = (content = "写测试", status = "pending", priority = "high") => ({
  type: "toolCall",
  toolName: "todowrite",
  input: { todos: [{ content, status, priority }] },
});

const assistant = (...content) => ({ role: "assistant", content });

test("无调用返回空快照", () => {
  assert.deepEqual(parseTodos([]), []);
  assert.deepEqual(parseTodos([{ role: "toolResult", content: [{ type: "text", text: "todowrite" }] }]), []);
});

test("提取单个快照并保留顺序和值", () => {
  const message = assistant({
    type: "toolCall",
    toolName: "todowrite",
    input: { todos: [
      { content: "第一项", status: "in_progress", priority: "medium" },
      { content: "第二项", status: "completed", priority: "low" },
    ] },
  });
  assert.deepEqual(parseTodos([message]).map((item) => ({
    content: item.content,
    status: item.status,
    priority: item.priority,
  })), [
    { content: "第一项", status: "in_progress", priority: "medium" },
    { content: "第二项", status: "completed", priority: "low" },
  ]);
});

test("后写合法快照覆盖之前快照，空数组清空", () => {
  assert.deepEqual(parseTodos([assistant(todo("旧项"), todo("新项"))]).map((item) => item.content), ["新项"]);
  assert.deepEqual(parseTodos([assistant(todo("旧项"), { ...todo(), input: { todos: [] } })]), []);
});

test("流式或非法快照不覆盖前一个合法快照", () => {
  const invalid = [
    { ...todo(), input: { todos: [{ content: "半成品", status: "pending" }] } },
    { ...todo(), input: { todos: [{ content: "错误", status: "blocked", priority: "high" }] } },
  ];
  assert.deepEqual(parseTodos([assistant(todo("保留"), ...invalid)]).map((item) => item.content), ["保留"]);
});

test("兼容 todowrite 工具名别名", () => {
  assert.equal(parseTodos([assistant({ ...todo(), toolName: "TODO_WRITE" })])[0].content, "写测试");
  assert.equal(parseTodos([assistant({ ...todo(), toolName: "todo-write" })])[0].content, "写测试");
});

test("拒绝非法 status、priority、content 和容器", () => {
  for (const input of [
    { todos: [{ content: "x", status: "blocked", priority: "high" }] },
    { todos: [{ content: "x", status: "pending", priority: "urgent" }] },
    { todos: [{ content: "", status: "pending", priority: "high" }] },
    { todos: { content: "x", status: "pending", priority: "high" } },
    { tasks: [{ content: "x", status: "pending", priority: "high" }] },
  ]) {
    assert.deepEqual(parseTodos([assistant(todo("保留"), { ...todo(), input })]).map((item) => item.content), ["保留"]);
  }
});

test("不从 toolResult 文本解析 todo", () => {
  const result = { role: "toolResult", content: [{ type: "text", text: JSON.stringify({ todos: [{ content: "伪造", status: "pending", priority: "high" }] }) }] };
  assert.deepEqual(parseTodos([result]), []);
});

test("不变异输入，id 稳定且重复文案仍唯一", () => {
  const messages = [assistant({ ...todo(), input: { todos: [
    { content: "重复", status: "pending", priority: "low" },
    { content: "重复", status: "pending", priority: "low" },
  ] } })];
  const before = structuredClone(messages);
  const first = parseTodos(messages);
  const second = parseTodos(messages);
  assert.deepEqual(messages, before);
  assert.deepEqual(first, second);
  assert.notEqual(first[0].id, first[1].id);
});
