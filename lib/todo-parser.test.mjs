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

// ---- rpiv-todo toolResult 快照(第二阶段 D1,#2)----

const rpivTask = (id, subject, status = "pending", extra = {}) => ({ id, subject, status, ...extra });

const rpivResult = (tasks, overrides = {}) => ({
  role: "toolResult",
  toolCallId: "tr-1",
  toolName: "todo",
  content: [{ type: "text", text: "ok" }],
  details: { action: "update", params: {}, tasks, nextId: 100, ...overrides },
});

test("A1: rpiv toolResult 快照解析,deleted 过滤,activeForm 透传,id 按任务号稳定", () => {
  const items = parseTodos([rpivResult([
    rpivTask(3, "写实现", "in_progress", { activeForm: "正在写实现" }),
    rpivTask(4, "已删项", "deleted"),
    rpivTask(5, "写文档", "completed"),
  ])]);
  assert.deepEqual(items.map((item) => ({ id: item.id, content: item.content, status: item.status, activeForm: item.activeForm })), [
    { id: "todo-3", content: "写实现", status: "in_progress", activeForm: "正在写实现" },
    { id: "todo-5", content: "写文档", status: "completed", activeForm: undefined },
  ]);
  assert.equal(items[0].priority, undefined);
});

test("A1: 仅接受 toolName 为 todo 且 details 含 tasks/nextId 的 toolResult", () => {
  const base = rpivResult([rpivTask(1, "任务")]);
  assert.equal(parseTodos([base]).length, 1);
  assert.deepEqual(parseTodos([{ ...base, toolName: "todos" }]), []);
  assert.deepEqual(parseTodos([{ ...base, toolName: undefined }]), []);
  assert.deepEqual(parseTodos([{ ...base, details: { tasks: [rpivTask(1, "任务")] } }]), []);
  assert.deepEqual(parseTodos([{ ...base, details: { tasks: {}, nextId: 2 } }]), []);
});

test("A1: 混合来源沿时间线后写覆盖", () => {
  const write = assistant(todo("todowrite 项"));
  const result = rpivResult([rpivTask(1, "rpiv 项")]);
  assert.deepEqual(parseTodos([write, result]).map((item) => item.content), ["rpiv 项"]);
  assert.deepEqual(parseTodos([result, write]).map((item) => item.content), ["todowrite 项"]);
});

test("A1: blockedBy 仅列未完成阻塞者,未知 id 回退 #id", () => {
  const items = parseTodos([rpivResult([
    rpivTask(1, "前置任务", "in_progress"),
    rpivTask(2, "已完成前置", "completed"),
    rpivTask(3, "被阻塞任务", "pending", { blockedBy: [1, 2, 9] }),
  ])]);
  const blocked = items.find((item) => item.id === "todo-3");
  assert.deepEqual(blocked.blockedBy, ["前置任务", "#9"]);
  assert.equal(items.find((item) => item.id === "todo-1").blockedBy, undefined);
});

test("A1: rpiv 单项损坏拒绝整个快照并保留上一合法快照", () => {
  const good = rpivResult([rpivTask(1, "保留")]);
  for (const tasks of [
    [rpivTask(1, "")],
    [rpivTask(1, "x", "blocked")],
    [{ id: "1", subject: "x", status: "pending" }],
    [rpivTask(1, "x", "pending", { blockedBy: ["2"] })],
    [rpivTask(1, "x", "pending", { activeForm: 3 })],
  ]) {
    assert.deepEqual(parseTodos([good, rpivResult(tasks)]).map((item) => item.content), ["保留"]);
  }
});
