import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const {
  parseNavigateTreeCommand,
  parseSetBranchLabelCommand,
  BRANCH_LABEL_MAX_LENGTH,
} = await jiti.import("./rpc-manager.ts");

test("RPC session startup preloads extension-registered providers before restoring models", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /createAgentSessionServices\(/);
  assert.match(startupSource, /createAgentSessionFromServices\(/);
  assert.doesNotMatch(startupSource, /await createAgentSession\(/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("parseNavigateTreeCommand 透传 summarize 与 trim 后的 customInstructions / targetId", () => {
  assert.deepEqual(
    parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "  entry-1  ",
      summarize: true,
      customInstructions: "  关注 diff  ",
    }),
    {
      targetId: "entry-1",
      summarize: true,
      customInstructions: "关注 diff",
    },
  );

  assert.deepEqual(
    parseNavigateTreeCommand({ type: "navigate_tree", targetId: "e2" }),
    { targetId: "e2" },
  );

  // 仅空白的 customInstructions 不透传
  assert.deepEqual(
    parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "e3",
      customInstructions: "   ",
    }),
    { targetId: "e3" },
  );
});

test("parseNavigateTreeCommand 拒绝非法参数与客户端 replaceInstructions", () => {
  assert.throws(
    () => parseNavigateTreeCommand({ type: "navigate_tree" }),
    /targetId is required/,
  );
  assert.throws(
    () => parseNavigateTreeCommand({ type: "navigate_tree", targetId: "  " }),
    /targetId is required/,
  );
  assert.throws(
    () => parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "e1",
      replaceInstructions: true,
    }),
    /replaceInstructions is not allowed/,
  );
  assert.throws(
    () => parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "e1",
      summarize: "yes",
    }),
    /summarize must be a boolean/,
  );
  assert.throws(
    () => parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "e1",
      customInstructions: 12,
    }),
    /customInstructions must be a string/,
  );
});

test("parseSetBranchLabelCommand 支持 set / clear，超长拒绝，targetId 已 trim", () => {
  assert.deepEqual(
    parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "  n1  ", label: "  书签A  " }),
    { targetId: "n1", label: "书签A" },
  );

  // trim 后空 → 清除
  assert.deepEqual(
    parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: "   " }),
    { targetId: "n1", label: undefined },
  );
  assert.deepEqual(
    parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: undefined }),
    { targetId: "n1", label: undefined },
  );

  assert.throws(
    () => parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: "x".repeat(BRANCH_LABEL_MAX_LENGTH + 1) }),
    /maximum length/,
  );
  assert.throws(
    () => parseSetBranchLabelCommand({ type: "set_branch_label", label: "ok" }),
    /targetId is required/,
  );
  assert.throws(
    () => parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1" }),
    /label is required/,
  );
  assert.throws(
    () => parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: 1 }),
    /label must be a string/,
  );

  // 边界：恰好最大长度可接受
  const max = "y".repeat(BRANCH_LABEL_MAX_LENGTH);
  assert.deepEqual(
    parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: max }),
    { targetId: "n1", label: max },
  );
});

test("navigate_tree / set_branch_label 命令 seam 存在于 send 分发", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /case "navigate_tree"/);
  assert.match(source, /parseNavigateTreeCommand\(command\)/);
  assert.match(source, /case "set_branch_label"/);
  assert.match(source, /appendLabelChange\(targetId, label\)/);
  assert.match(source, /invalidateSessionListCache\(\)/);
  // 返回完整 SDK 结果，不只 cancelled
  const navCase = source.slice(
    source.indexOf('case "navigate_tree"'),
    source.indexOf('case "set_branch_label"'),
  );
  assert.match(navCase, /return result;/);
  assert.doesNotMatch(navCase, /return \{ cancelled: result\.cancelled \}/);
});

// ---------------------------------------------------------------------------
// 活动自动持久化：wrapper 行为（stub inner，不启真实 AgentSession）
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, unknown>} [overrides]
 */
function createActivityStub(overrides = {}) {
  /** @type {Array<{ customType: string, data: unknown, id: string }>} */
  const appended = [];
  /** @type {(text: string, options?: unknown) => Promise<void>} */
  let promptImpl = async () => {};

  const sessionManager = {
    appendCustomEntry(customType, data) {
      const id = `entry-${appended.length + 1}`;
      appended.push({ customType, data, id });
      return id;
    },
    getSessionFile: () => undefined,
    getHeader: () => null,
    getEntries: () => [],
  };

  const inner = {
    sessionId: "act-test-session",
    sessionFile: "/tmp/act-test.jsonl",
    isStreaming: false,
    isCompacting: false,
    autoCompactionEnabled: false,
    autoRetryEnabled: false,
    model: undefined,
    modelRuntime: { getModel: () => undefined },
    sessionManager,
    settingsManager: {},
    agent: { state: {} },
    extensionRunner: {},
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    isBashRunning: false,
    pendingMessageCount: 0,
    subscribe: () => () => {},
    prompt: (text, options) => promptImpl(text, options),
    abort: async () => {},
    executeBash: async () => ({ output: "ok", exitCode: 0 }),
    abortBash: () => {},
    setModel: async () => {},
    navigateTree: async () => ({ cancelled: true }),
    setThinkingLevel: () => {},
    compact: async () => ({}),
    setSessionName: () => {},
    getSessionStats: () => ({
      sessionId: "act-test-session",
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    }),
    getLastAssistantText: () => undefined,
    setAutoCompactionEnabled: () => {},
    setAutoRetryEnabled: () => {},
    steer: async () => {},
    followUp: async () => {},
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    clearQueue: () => ({ steering: [], followUp: [] }),
    getAllTools: () => [],
    getActiveToolNames: () => [],
    setActiveToolsByName: () => {},
    abortCompaction: () => {},
    getContextUsage: () => undefined,
    ...overrides,
  };

  return {
    appended,
    inner,
    setPromptImpl(fn) {
      promptImpl = fn;
    },
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 语义比较 metadata：normalize 使用 Object.create(null) 是安全实现，
 * 不得用 deepStrictEqual 把 null-prototype 当错误。
 * @param {unknown} actual
 * @param {Record<string, unknown> | undefined} expected
 */
function assertMetadataEqual(actual, expected) {
  if (expected === undefined) {
    assert.equal(actual, undefined);
    return;
  }
  assert.equal(typeof actual, "object");
  assert.notEqual(actual, null);
  assert.equal(Array.isArray(actual), false);
  // 展开为普通对象后再 deepEqual，忽略原型差异
  assert.deepEqual({ .../** @type {Record<string, unknown>} */ (actual) }, expected);
}

/**
 * 注册 wrapper 清理：idle timer / pending UI / custom UI 必须在 finally 释放，
 * 否则 node:test 句柄不退出。不得缩短生产 idle timeout，不得 process.exit。
 * @param {import("node:test").TestContext} t
 * @param {{ destroy: () => void }} wrapper
 */
function trackWrapper(t, wrapper) {
  t.after(() => {
    try {
      wrapper.destroy();
    } catch {
      // destroy 幂等；清理阶段吞掉二次销毁噪音
    }
  });
  return wrapper;
}

test("wrapper：prompt rejection 仅一次 append + 一次 prompt_error", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const { PIDANCE_ACTIVITY_CUSTOM_TYPE } = await jiti.import("./session-activity.ts");
  const stub = createActivityStub();
  stub.setPromptImpl(async () => {
    throw new Error("model unavailable");
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  wrapper.onEvent((e) => events.push(e));

  // P0-1：预检/提交失败时 send 抛错（不得只报告调度成功）
  await assert.rejects(() => wrapper.send({ type: "prompt", message: "hi" }), /model unavailable/);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(stub.appended.length, 1);
  assert.equal(stub.appended[0].customType, PIDANCE_ACTIVITY_CUSTOM_TYPE);
  assert.equal(stub.appended[0].data.kind, "error");
  assert.equal(stub.appended[0].data.source, "rpc.prompt_error");
  assert.equal(stub.appended[0].data.content, "model unavailable");
  assert.equal(stub.appended[0].data.title, "Prompt failed");

  const promptErrors = events.filter((e) => e.type === "prompt_error");
  assert.equal(promptErrors.length, 1);
  assert.equal(promptErrors[0].errorMessage, "model unavailable");
  // prompt_done 也各一次
  assert.equal(events.filter((e) => e.type === "prompt_done").length, 1);
});

test("wrapper：prompt rejection 带 streamingBehavior 写入 metadata", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const stub = createActivityStub();
  stub.setPromptImpl(async () => {
    throw new Error("steer fail");
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  await assert.rejects(() => wrapper.send({ type: "prompt", message: "x", streamingBehavior: "steer" }), /steer fail/);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(stub.appended.length, 1);
  assertMetadataEqual(stub.appended[0].data.metadata, { streamingBehavior: "steer" });
});

// ---------------------------------------------------------------------------
// P0-1：首条 prompt 提交确认——send 不得只报告「调度成功」
// ---------------------------------------------------------------------------

test("wrapper：prompt preflightResult(false) 视为提交失败，send 抛错且错误事件回流", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const stub = createActivityStub();
  stub.setPromptImpl(async (_text, options) => {
    // SDK 预检失败路径：先回调 false（消息不会进入会话），再 reject
    options?.preflightResult?.(false);
    throw new Error("No API key found for provider X");
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  wrapper.onEvent((e) => events.push(e));

  // 配置无效：send 抛明确错误，不得静默成功
  await assert.rejects(
    () => wrapper.send({ type: "prompt", message: "hi" }),
    /Prompt rejected before submission/,
  );
  await flushMicrotasks();
  await flushMicrotasks();

  // 异步失败仍回流：prompt_error（原始错误消息）+ prompt_done 各一次
  const promptErrors = events.filter((e) => e.type === "prompt_error");
  assert.equal(promptErrors.length, 1);
  assert.equal(promptErrors[0].errorMessage, "No API key found for provider X");
  assert.equal(events.filter((e) => e.type === "prompt_done").length, 1);
  // 预检失败消息未进入会话：不写 user entry（无 append）
  assert.equal(stub.appended.length, 1); // 仅 prompt_error 活动
});

test("wrapper：prompt preflightResult(true) 提交确认后 send 返回，运行完成 emit prompt_done", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const stub = createActivityStub();
  /** @type {(() => void) | null} */
  let resolveRun = null;
  stub.setPromptImpl((_text, options) => new Promise((resolve) => {
    // SDK 预检通过路径：回调 true（消息即将提交落盘），随后 run 运行中
    options?.preflightResult?.(true);
    resolveRun = resolve;
  }));
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  wrapper.onEvent((e) => events.push(e));

  // 预检通过：send 在提交确认后返回（不等待 run 完成）
  const result = await wrapper.send({ type: "prompt", message: "hi" });
  assert.equal(result, null);
  assert.equal(events.filter((e) => e.type === "prompt_error").length, 0);
  assert.equal(events.filter((e) => e.type === "prompt_done").length, 0);

  // 模拟 run 完成
  resolveRun?.();
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(events.filter((e) => e.type === "prompt_done").length, 1);
  assert.equal(events.filter((e) => e.type === "prompt_error").length, 0);
});

test("wrapper：SDK 成功完成 prompt 但从不调用 preflightResult → send 最终 resolve 不挂起（P1-3）", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const stub = createActivityStub();
  // 旧 SDK / 桩：prompt 直接 resolve，从不回调 preflightResult
  stub.setPromptImpl(async () => {});
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  wrapper.onEvent((e) => events.push(e));

  // 带超时护栏：若修复缺失，send 永久挂起 → 2s 后断言失败并给出明确原因
  const result = await Promise.race([
    wrapper.send({ type: "prompt", message: "hi" }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("send 永久挂起：SDK 成功但无 preflightResult 回调")), 2000),
    ),
  ]);
  assert.equal(result, null);
  await flushMicrotasks();

  // 完整 prompt 完成后：无 prompt_error，prompt_done 恰好一次
  assert.equal(events.filter((e) => e.type === "prompt_error").length, 0);
  assert.equal(events.filter((e) => e.type === "prompt_done").length, 1);
});

test("wrapper：extension_error 三生产点统一 helper，各一次 append + 一次 emit", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const { PIDANCE_ACTIVITY_CUSTOM_TYPE } = await jiti.import("./session-activity.ts");

  /** @type {((err: { extensionPath: string, event: string, error: string }) => void) | null} */
  let onError = null;
  /** @type {{ notify: (message: string, type?: string) => void, custom: (factory: unknown, options?: unknown) => Promise<unknown> } | null} */
  let uiContext = null;

  const stub = createActivityStub({
    bindExtensions: async (bindings) => {
      onError = bindings.onError;
      uiContext = bindings.uiContext;
    },
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  wrapper.onEvent((e) => events.push(e));

  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  assert.ok(onError);
  assert.ok(uiContext);

  // 生产点 1：bindExtensions onError
  onError({
    extensionPath: "/ext/a.ts",
    event: "session_start",
    error: "bind fail",
  });
  assert.equal(stub.appended.length, 1);
  assert.equal(stub.appended[0].customType, PIDANCE_ACTIVITY_CUSTOM_TYPE);
  assert.equal(stub.appended[0].data.source, "extension_error");
  assert.equal(stub.appended[0].data.content, "bind fail");
  assertMetadataEqual(stub.appended[0].data.metadata, {
    extensionPath: "/ext/a.ts",
    event: "session_start",
  });
  assert.equal(
    events.filter((e) => e.type === "extension_error" && e.error === "bind fail").length,
    1,
  );

  // 生产点 2：custom_ui factory 失败 → emitExtensionError
  await uiContext.custom(async () => {
    throw new Error("factory boom");
  });
  await flushMicrotasks();
  const afterCustom = stub.appended.length;
  assert.equal(afterCustom, 2);
  assert.equal(stub.appended[1].data.source, "extension_error");
  assert.match(String(stub.appended[1].data.metadata?.event), /custom_ui/);
  assert.equal(
    events.filter((e) => e.type === "extension_error" && String(e.error).includes("factory boom")).length,
    1,
  );

  // 生产点 3：挂载合法 component（不 await：promise 在 close/destroy 才 settle）
  // handleExtensionUiInput 为私有；此处用 onError 验证同一 helper 形状与单次 append
  void uiContext.custom(async () => ({
    render: () => ["line"],
    handleInput: () => {
      throw new Error("input boom");
    },
  }));
  await flushMicrotasks();
  const beforeThird = stub.appended.length;
  onError({
    extensionPath: "custom-ui:x",
    event: "custom_ui_input",
    error: "input boom",
  });
  assert.equal(stub.appended.length, beforeThird + 1);
  assertMetadataEqual(stub.appended[beforeThird].data.metadata, {
    extensionPath: "custom-ui:x",
    event: "custom_ui_input",
  });
  assert.equal(
    events.filter((e) => e.type === "extension_error" && e.error === "input boom").length,
    1,
  );

  // 每次 extension_error 恰好 1 append，无双写
  const extAppends = stub.appended.filter((a) => a.data.source === "extension_error");
  const extEvents = events.filter((e) => e.type === "extension_error");
  assert.equal(extAppends.length, extEvents.length);
});

test("wrapper：notify warning/error 各写一次；info/success/缺省不写；原事件仍 emit", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const { PIDANCE_ACTIVITY_CUSTOM_TYPE } = await jiti.import("./session-activity.ts");

  /** @type {{ notify: (message: string, type?: string) => void } | null} */
  let ui = null;
  const stub = createActivityStub({
    bindExtensions: async (bindings) => {
      ui = bindings.uiContext;
    },
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  wrapper.onEvent((e) => events.push(e));
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  assert.ok(ui);

  ui.notify("warn me", "warning");
  ui.notify("err me", "error");
  ui.notify("info me", "info");
  ui.notify("ok me", "success");
  ui.notify("default me"); // 缺省

  assert.equal(stub.appended.length, 2);
  assert.equal(stub.appended[0].customType, PIDANCE_ACTIVITY_CUSTOM_TYPE);
  assert.equal(stub.appended[0].data.kind, "warning");
  assert.equal(stub.appended[0].data.source, "extension.ui.notify");
  assert.equal(stub.appended[0].data.content, "warn me");
  assertMetadataEqual(stub.appended[0].data.metadata, { notifyType: "warning" });
  assert.equal(stub.appended[1].data.kind, "error");
  assert.equal(stub.appended[1].data.content, "err me");
  assertMetadataEqual(stub.appended[1].data.metadata, { notifyType: "error" });

  const notifyEvents = events.filter(
    (e) => e.type === "extension_ui_request" && e.method === "notify",
  );
  // 5 次 notify 各 emit 一次，与 append 解耦
  assert.equal(notifyEvents.length, 5);
  assert.equal(notifyEvents[0].notifyType, "warning");
  assert.equal(notifyEvents[1].notifyType, "error");
  assert.equal(notifyEvents[2].notifyType, "info");
  assert.equal(notifyEvents[3].notifyType, "success");
  assert.equal(notifyEvents[4].notifyType, undefined);

  // 不同 id（每次 randomUUID）同文案各写一次
  ui.notify("same", "warning");
  ui.notify("same", "warning");
  assert.equal(stub.appended.length, 4);
});

test("wrapper：显式 append_activity 仅一条且保留抛错语义", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const { PIDANCE_ACTIVITY_CUSTOM_TYPE, SessionActivityError } = await jiti.import(
    "./session-activity.ts",
  );
  const stub = createActivityStub();
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));

  const result = await wrapper.send({
    type: "append_activity",
    kind: "result",
    title: "manual",
    content: "body",
  });
  assert.equal(stub.appended.length, 1);
  assert.equal(stub.appended[0].customType, PIDANCE_ACTIVITY_CUSTOM_TYPE);
  assert.equal(stub.appended[0].data.title, "manual");
  assert.equal(result.activity.title, "manual");

  // 非法 input 仍抛（非 best-effort）
  await assert.rejects(
    () => wrapper.send({ type: "append_activity", kind: "nope", title: "t", content: "" }),
    (err) => err instanceof SessionActivityError || /kind must be one of/.test(String(err)),
  );
  assert.equal(stub.appended.length, 1);

  // customType 禁止
  await assert.rejects(
    () =>
      wrapper.send({
        type: "append_activity",
        kind: "result",
        title: "t",
        content: "",
        customType: "evil",
      }),
    /customType is not allowed/,
  );
  assert.equal(stub.appended.length, 1);
});

test("wrapper：bash 路径不自动写 activity", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const stub = createActivityStub();
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));

  await wrapper.send({ type: "bash", command: "echo hi" });
  assert.equal(stub.appended.length, 0);
});

test("wrapper：append 失败不阻断 prompt_error 原事件", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const stub = createActivityStub();
  stub.inner.sessionManager.appendCustomEntry = () => {
    throw new Error("disk full");
  };
  stub.setPromptImpl(async () => {
    throw new Error("prompt boom");
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  wrapper.onEvent((e) => events.push(e));

  // P0-1：提交失败时 send 抛错（append 失败不阻断原 prompt_error 事件回流）
  await assert.rejects(() => wrapper.send({ type: "prompt", message: "x" }), /prompt boom/);
  await flushMicrotasks();
  await flushMicrotasks();

  const promptErrors = events.filter((e) => e.type === "prompt_error");
  assert.equal(promptErrors.length, 1);
  assert.equal(promptErrors[0].errorMessage, "prompt boom");
});

test("活动自动持久化源码契约：extension_error 三生产点 + notify owner + 无双 emit", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  // 三个生产点均走 emitExtensionError
  assert.match(source, /onError:\s*\(error\)\s*=>\s*this\.emitExtensionError\(error\)/);
  assert.match(source, /this\.emitExtensionError\(\{\s*extensionPath: `custom-ui:\$\{id\}`,\s*event: "custom_ui_input"/);
  assert.match(source, /this\.emitExtensionError\(\{\s*extensionPath: `custom-ui:\$\{id\}`,\s*event: "custom_ui"/);

  // emitExtensionError 内仅一次 tryAutoPersist + 一次 emit extension_error
  const emitExt = source.slice(
    source.indexOf("private emitExtensionError"),
    source.indexOf("async send(command"),
  );
  assert.equal((emitExt.match(/tryAutoPersistActivity/g) || []).length, 1);
  // 恰好一处 this.emit({ type: "extension_error" ... }（允许换行/空白）
  assert.equal((emitExt.match(/this\.emit\(\s*\{\s*type:\s*"extension_error"/g) || []).length, 1);
  assert.equal((emitExt.match(/type:\s*"extension_error"/g) || []).length, 1);

  // notify 经 persistExtensionNotify 单一 owner
  assert.match(source, /persistExtensionNotify\(/);
  assert.match(source, /createNotifyPersistState\(/);
  assert.match(source, /notifyPersistState/);

  // 原生 bash/tool 路径无 tryAutoPersist
  const bashCase = source.slice(source.indexOf('case "bash"'), source.indexOf('case "abort_bash"'));
  assert.doesNotMatch(bashCase, /tryAutoPersistActivity|persistExtensionNotify|appendActivity/);

  // prompt 路径仅一次 tryAutoPersist + 一次 prompt_error
  const promptCase = source.slice(source.indexOf('case "prompt"'), source.indexOf('case "abort"'));
  assert.equal((promptCase.match(/tryAutoPersistActivity/g) || []).length, 1);
  assert.equal((promptCase.match(/type:\s*"prompt_error"/g) || []).length, 1);
});

// ---------------------------------------------------------------------------
// A6：fork send → destroy → registry 清除；不调用真实 startRpcSession
// ---------------------------------------------------------------------------

/**
 * 仅镜像 startRpcSession 的 registry 挂载/onDestroy 删除契约，便于断言 getRpcSession。
 * 本 helper 不是 startRpcSession，也不触发 SDK 会话创建。
 * @param {string} sessionId
 * @param {{ onDestroy: (cb: () => void) => void }} wrapper
 */
function registerWrapperLikeStart(sessionId, wrapper) {
  if (!globalThis.__piSessions) globalThis.__piSessions = new Map();
  const registry = globalThis.__piSessions;
  wrapper.onDestroy(() => {
    if (registry.get(sessionId) === wrapper) registry.delete(sessionId);
  });
  registry.set(sessionId, wrapper);
  return registry;
}

test("A6：fork send 后立即 destroy 并清 registry；dead 不满足 start 复用前置；原 JSONL 重开可得无污染新 wrapper", async (t) => {
  const { AgentSessionWrapper, getRpcSession } = await jiti.import("./rpc-manager.ts");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-a6-fork-"));
  /** @type {string | undefined} */
  let originalId;
  try {
    // 真实 SessionManager 持久化会话（tmpdir，不碰 ~/.pi/agent）
    const sm = SessionManager.create(dir, dir);
    const originalFile = sm.getSessionFile();
    assert.ok(originalFile);
    originalId = sm.getSessionId();
    assert.ok(originalId);
    assert.equal(sm.isPersisted(), true);

    sm.appendModelChange("test", "model-a");
    const userId = sm.appendMessage({
      role: "user",
      content: "fork-at-me",
      timestamp: Date.now(),
    });
    const asstId = sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "A" }],
      api: "test",
      provider: "test",
      model: "model-a",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    // fork 点需有 parentId，走 createBranchedSession 分支
    const forkEntry = sm.getEntry(asstId);
    assert.ok(forkEntry?.parentId);
    assert.equal(forkEntry.parentId, userId);

    const stub = createActivityStub({
      sessionId: originalId,
      sessionFile: originalFile,
      sessionManager: sm,
      isBashRunning: false,
    });
    // 污染标记：若错误复用旧 inner，新 wrapper 会读到它（非真实 start 路径）
    /** @type {Record<string, unknown>} */ (stub.inner).__a6ForkPoison = "stale-inner";

    const oldWrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
    registerWrapperLikeStart(originalId, oldWrapper);

    assert.equal(getRpcSession(originalId), oldWrapper);
    assert.equal(oldWrapper.isAlive(), true);

    // 真实行为：AgentSessionWrapper.send({type:"fork"}) 在返回前 destroy
    const result = await oldWrapper.send({ type: "fork", entryId: asstId });
    assert.equal(result.cancelled, false);
    assert.equal(typeof result.newSessionId, "string");
    assert.ok(result.newSessionId);
    assert.notEqual(result.newSessionId, originalId);

    // 真实验证：fork 后 destroy + registry 清除
    assert.equal(oldWrapper.isAlive(), false);
    assert.equal(getRpcSession(originalId), undefined);
    assert.equal(globalThis.__piSessions?.has(originalId), false);

    // 契约片段（非调用 startRpcSession）：复用前置为 existing?.isAlive()；
    // 即便 dead wrapper 残留 registry，也不满足复用条件
    if (globalThis.__piSessions) {
      globalThis.__piSessions.set(originalId, oldWrapper);
    }
    const residual = getRpcSession(originalId);
    assert.equal(residual, oldWrapper);
    assert.equal(residual?.isAlive(), false);
    const meetsStartReuseGuard = residual?.isAlive() === true;
    assert.equal(meetsStartReuseGuard, false);
    globalThis.__piSessions?.delete(originalId);

    // 等价重载验证（未调用 startRpcSession / ensureLive）：
    // 从原 JSONL 重开 SessionManager，再构造新 wrapper，证明可得无污染 inner
    const reopened = SessionManager.open(originalFile, dir);
    assert.equal(reopened.getSessionId(), originalId);
    const reloadStub = createActivityStub({
      sessionId: originalId,
      sessionFile: originalFile,
      sessionManager: reopened,
      isBashRunning: false,
    });
    const newWrapper = trackWrapper(t, new AgentSessionWrapper(reloadStub.inner));
    registerWrapperLikeStart(originalId, newWrapper);

    assert.notEqual(newWrapper, oldWrapper);
    assert.notEqual(newWrapper.inner, oldWrapper.inner);
    assert.equal(/** @type {Record<string, unknown>} */ (newWrapper.inner).__a6ForkPoison, undefined);
    assert.equal(getRpcSession(originalId), newWrapper);
    assert.equal(newWrapper.isAlive(), true);
    assert.equal(newWrapper.sessionId, originalId);
    assert.equal(newWrapper.sessionFile, originalFile);
  } finally {
    if (originalId && globalThis.__piSessions?.get(originalId)) {
      try {
        globalThis.__piSessions.get(originalId)?.destroy();
      } catch {
        // 清理
      }
      globalThis.__piSessions.delete(originalId);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P2-10：渲染桥真实 wrapper 行为测试（替代源码正则契约）
// 通过可观察 listener 实例化 AgentSessionWrapper + 注入假 extensionRunner，
// 验证异常隔离、P0-1 context 契约、isError、setWidget 回退、输出上限等行为。
// ---------------------------------------------------------------------------

/**
 * 渲染桥行为测试 stub：捕获 subscribe listener 并向其 fire 事件，
 * 支持注入假 extensionRunner（getToolDefinition / getMessageRenderer）。
 * @param {Record<string, unknown>} [overrides]
 */
function createRenderBridgeStub(overrides = {}) {
  const base = createActivityStub();
  /** @type {((event: Record<string, unknown>) => void) | null} */
  let listener = null;
  const inner = {
    ...base.inner,
    subscribe: (fn) => {
      listener = fn;
      return () => {
        if (listener === fn) listener = null;
      };
    },
    ...overrides,
  };
  return {
    ...base,
    inner,
    /**
     * @param {Record<string, unknown>} event
     */
    fire(event) {
      listener?.(event);
    },
  };
}

/** 便捷：构造普通组件对象（无需 pi-tui 依赖）。 */
function fakeComponent(...lines) {
  return { render: () => lines };
}

test("渲染桥行为：getToolDefinition 抛错 → 原事件仍 emit（异常隔离）", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const stub = createRenderBridgeStub({
    extensionRunner: {
      getToolDefinition: () => {
        throw new Error("runner boom");
      },
    },
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  wrapper.onEvent((e) => events.push(e));
  wrapper.start();

  stub.fire({ type: "tool_call", toolName: "subagent", toolCallId: "c1", input: { agent: "x" } });
  stub.fire({ type: "tool_result", toolName: "subagent", toolCallId: "c1", content: [], details: {} });

  assert.equal(events.length, 2, "两个事件都应 emit");
  assert.equal(events[0].type, "tool_call");
  assert.equal(events[1].type, "tool_result");
  assert.equal("renderedCallLines" in events[0], false, "异常时不得附加渲染行");
  assert.equal("renderedResultLines" in events[1], false);
});

test("渲染桥行为：渲染器抛错 / component.render 抛错 → 原事件仍 emit", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

  // 渲染器抛错
  const rendererThrows = {
    extensionRunner: {
      getToolDefinition: () => ({ renderResult: () => { throw new Error("renderer boom"); } }),
    },
  };
  const stubA = createRenderBridgeStub(rendererThrows);
  const wrapperA = trackWrapper(t, new AgentSessionWrapper(stubA.inner));
  /** @type {Array<Record<string, unknown>>} */
  const eventsA = [];
  wrapperA.onEvent((e) => eventsA.push(e));
  wrapperA.start();
  stubA.fire({ type: "tool_result", toolName: "t", toolCallId: "c1", content: [], details: {} });
  assert.equal(eventsA.length, 1, "原事件仍 emit");
  assert.equal("renderedResultLines" in eventsA[0], false);

  // component.render 抛错
  const renderThrows = {
    extensionRunner: {
      getToolDefinition: () => ({
        renderResult: () => fakeComponent("ok"),
      }),
    },
  };
  // fakeComponent 不抛；改用抛 render 的组件
  const stubB = createRenderBridgeStub({
    extensionRunner: {
      getToolDefinition: () => ({
        renderResult: () => ({ render: () => { throw new Error("render boom"); } }),
      }),
    },
  });
  const wrapperB = trackWrapper(t, new AgentSessionWrapper(stubB.inner));
  /** @type {Array<Record<string, unknown>>} */
  const eventsB = [];
  wrapperB.onEvent((e) => eventsB.push(e));
  wrapperB.start();
  stubB.fire({ type: "tool_result", toolName: "t", toolCallId: "c1", content: [], details: {} });
  assert.equal(eventsB.length, 1, "原事件仍 emit");
  assert.equal("renderedResultLines" in eventsB[0], false);
});

test("渲染桥行为：renderResult 可安全访问 context.state（pi-subagents clearLegacyResultAnimationTimer 契约，P0-1）", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  let timerSeen = "unset";
  const def = {
    renderResult: (result, options, theme, context) => {
      // 镜像 pi-subagents：clearLegacyResultAnimationTimer(context) 访问 context.state
      const timer = context.state.subagentResultAnimationTimer;
      timerSeen = timer === undefined ? "undefined" : "defined";
      context.state.subagentResultAnimationTimer = undefined;
      return fakeComponent(`status: ${result.details?.status ?? "none"}`);
    },
  };
  const stub = createRenderBridgeStub({
    extensionRunner: { getToolDefinition: () => def },
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  wrapper.onEvent((e) => events.push(e));
  wrapper.start();

  stub.fire({
    type: "tool_result",
    toolName: "subagent",
    toolCallId: "c1",
    content: [],
    details: { status: "paused" },
  });

  assert.equal(timerSeen, "undefined", "context.state 必须存在且可安全读写");
  assert.equal(events[0].type, "tool_result");
  assert.ok(
    events[0].renderedResultLines?.some((line) => line.includes("status: paused")),
    "真实契约渲染路径应产出渲染行",
  );
});

test("渲染桥行为：context 含 state/lastComponent/executionStarted 且跨事件保持（P0-1）", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  /** @type {unknown[]} */
  const seenContexts = [];
  let resultCount = 0;
  const callComponent = fakeComponent("call-render");
  const firstResultComponent = fakeComponent("result-1");
  const def = {
    renderCall: (args, theme, context) => {
      seenContexts.push({ kind: "call", context });
      return callComponent;
    },
    renderResult: (result, options, theme, context) => {
      resultCount += 1;
      seenContexts.push({ kind: "result", context });
      // 第二次 result 时 lastComponent 应为上一 result 组件
      return resultCount === 1
        ? firstResultComponent
        : fakeComponent("result-2");
    },
  };
  const stub = createRenderBridgeStub({
    extensionRunner: { getToolDefinition: () => def },
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  wrapper.onEvent(() => {});
  wrapper.start();

  stub.fire({ type: "tool_call", toolName: "t", toolCallId: "c1", input: { agent: "x" } });
  stub.fire({ type: "tool_result", toolName: "t", toolCallId: "c1", content: [], details: {} });
  stub.fire({ type: "tool_result", toolName: "t", toolCallId: "c1", content: [], details: {} });

  const callCtx = seenContexts[0].context;
  const result1Ctx = seenContexts[1].context;
  const result2Ctx = seenContexts[2].context;
  assert.ok(callCtx.state && typeof callCtx.state === "object", "context.state 存在");
  assert.equal(callCtx.executionStarted, true);
  assert.equal(callCtx.argsComplete, true);
  assert.equal(typeof callCtx.invalidate, "function");
  assert.equal(callCtx.expanded, true);

  // 跨事件共享同一 state 对象
  assert.equal(result1Ctx.state, callCtx.state, "state 跨事件保持同一对象");
  assert.equal(result2Ctx.state, callCtx.state, "state 第三次仍同一对象");

  // lastComponent：renderCall 槽与 renderResult 槽分离，且 result 槽更新
  assert.equal(callCtx.lastComponent, undefined, "首次 call 无上一组件");
  assert.equal(result1Ctx.lastComponent, undefined, "首次 result 无上一组件");
  assert.equal(result2Ctx.lastComponent, firstResultComponent, "result 槽记录上一 result 组件");
});

test("渲染桥行为：tool_result 收到含 isError 的结果对象（P1-3）", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  /** @type {unknown[]} */
  const seenResults = [];
  const def = {
    renderResult: (result) => {
      seenResults.push(result);
      return fakeComponent("ok");
    },
  };
  const stub = createRenderBridgeStub({
    extensionRunner: { getToolDefinition: () => def },
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  wrapper.onEvent(() => {});
  wrapper.start();

  stub.fire({
    type: "tool_result",
    toolName: "t",
    toolCallId: "c1",
    content: [{ type: "text", text: "x" }],
    details: { ok: true },
    isError: true,
  });
  stub.fire({
    type: "tool_result",
    toolName: "t",
    toolCallId: "c2",
    content: [],
    details: {},
  });

  assert.equal(seenResults[0].isError, true, "错误结果 isError 应为 true");
  assert.equal(seenResults[0].content[0].text, "x", "content 原样传入");
  assert.deepEqual(seenResults[0].details, { ok: true }, "details 原样传入");
  assert.equal(seenResults[1].isError, false, "缺省 isError 应为 false");
});

test("渲染桥行为：context.cwd 取会话 header 真实项目 cwd（P1-2）", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  /** @type {unknown[]} */
  const seenCtxs = [];
  const def = {
    renderCall: (args, theme, context) => {
      seenCtxs.push(context);
      return fakeComponent("ok");
    },
  };

  // 持久会话：header.cwd 为真实项目目录
  const persistedSessionManager = {
    ...createActivityStub().inner.sessionManager,
    getHeader: () => ({ type: "session", id: "s1", timestamp: "t", cwd: "/real/project" }),
  };
  const stubA = createRenderBridgeStub({
    sessionManager: persistedSessionManager,
    extensionRunner: { getToolDefinition: () => def },
  });
  const wrapperA = trackWrapper(t, new AgentSessionWrapper(stubA.inner));
  wrapperA.onEvent(() => {});
  wrapperA.start();
  stubA.fire({ type: "tool_call", toolName: "t", toolCallId: "c1", input: {} });
  assert.equal(seenCtxs[0].cwd, "/real/project", "持久会话应取 header.cwd");

  // 新会话：无 header → 回退 process.cwd()
  const stubB = createRenderBridgeStub({
    extensionRunner: { getToolDefinition: () => def },
  });
  const wrapperB = trackWrapper(t, new AgentSessionWrapper(stubB.inner));
  wrapperB.onEvent(() => {});
  wrapperB.start();
  stubB.fire({ type: "tool_call", toolName: "t", toolCallId: "c2", input: {} });
  assert.equal(seenCtxs[1].cwd, process.cwd(), "新会话应回退 process.cwd()");
});

test("渲染桥行为：setWidget 工厂失败 → 旧 widget 不变（P1-7 回退）", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  /** @type {{ setWidget: (key: string, content: unknown, options?: unknown) => void } | null} */
  let ui = null;
  const stub = createRenderBridgeStub({
    bindExtensions: async (bindings) => {
      ui = bindings.uiContext;
    },
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  wrapper.onEvent(() => {});
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  assert.ok(ui);

  // 先设置合法行 widget
  ui.setWidget("k", ["old-line"]);
  let state = await wrapper.send({ type: "get_state" });
  assert.deepEqual(state.extensionWidgets.find((w) => w.key === "k").lines, ["old-line"]);

  // 工厂抛错 → 静默，旧 widget 不变
  ui.setWidget("k", () => { throw new Error("factory boom"); });
  state = await wrapper.send({ type: "get_state" });
  assert.deepEqual(
    state.extensionWidgets.find((w) => w.key === "k").lines,
    ["old-line"],
    "工厂失败不得覆盖旧 widget",
  );

  // 工厂返回超限输出 → 静默，旧 widget 不变
  const { RENDER_MAX_LINES } = await jiti.import("./tui-render-bridge.ts");
  ui.setWidget("k", () => ({ render: () => Array(RENDER_MAX_LINES + 1).fill("x") }));
  state = await wrapper.send({ type: "get_state" });
  assert.deepEqual(
    state.extensionWidgets.find((w) => w.key === "k").lines,
    ["old-line"],
    "超限输出不得覆盖旧 widget",
  );
});

test("渲染桥行为：渲染行超限 → 事件无 renderedLines（回退，P1-6）", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const { RENDER_MAX_LINES, RENDER_MAX_LINE_LENGTH } = await jiti.import("./tui-render-bridge.ts");
  const def = {
    renderResult: () => ({ render: () => Array(RENDER_MAX_LINES + 1).fill("x") }),
  };
  const stub = createRenderBridgeStub({
    extensionRunner: { getToolDefinition: () => def },
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  wrapper.onEvent((e) => events.push(e));
  wrapper.start();
  stub.fire({ type: "tool_result", toolName: "t", toolCallId: "c1", content: [], details: {} });
  assert.equal(events[0].type, "tool_result", "事件仍 emit");
  assert.equal("renderedResultLines" in events[0], false, "超限不附加渲染行");
});

test("渲染桥行为：tool_execution_update 按 toolCallId 节流（P1-6）", async (t) => {
  const { AgentSessionWrapper, PARTIAL_RENDER_MIN_INTERVAL_MS } = await jiti.import("./rpc-manager.ts");
  const def = {
    renderResult: (result) => fakeComponent(`u:${result?.n ?? "?"}`),
  };
  const stub = createRenderBridgeStub({
    extensionRunner: { getToolDefinition: () => def },
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  wrapper.onEvent((e) => events.push(e));
  wrapper.start();

  // 连续两次快速 update（同一 toolCallId）→ 第二次被节流
  stub.fire({ type: "tool_execution_update", toolName: "t", toolCallId: "c1", partialResult: { n: 1 } });
  stub.fire({ type: "tool_execution_update", toolName: "t", toolCallId: "c1", partialResult: { n: 2 } });
  assert.ok(events[0].renderedLines, "首次 update 应渲染");
  assert.equal("renderedLines" in events[1], false, "间隔内第二次 update 应被节流");

  // 不同 toolCallId 不受影响
  stub.fire({ type: "tool_execution_update", toolName: "t", toolCallId: "c2", partialResult: { n: 3 } });
  assert.ok(events[2].renderedLines, "不同 toolCallId 不节流");

  // 超过最短间隔后恢复渲染
  await new Promise((resolve) => setTimeout(resolve, PARTIAL_RENDER_MIN_INTERVAL_MS + 20));
  stub.fire({ type: "tool_execution_update", toolName: "t", toolCallId: "c1", partialResult: { n: 4 } });
  assert.ok(events[3].renderedLines, "间隔后应恢复渲染");
});

test("渲染桥行为：tool_execution_end 释放状态 → 同 toolCallId 后续渲染用全新 state（P0-1 生命周期）", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  /** @type {unknown[]} */
  const seenStates = [];
  const def = {
    renderCall: (args, theme, context) => {
      seenStates.push(context.state);
      return fakeComponent("ok");
    },
  };
  const stub = createRenderBridgeStub({
    extensionRunner: { getToolDefinition: () => def },
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  wrapper.onEvent(() => {});
  wrapper.start();

  stub.fire({ type: "tool_call", toolName: "t", toolCallId: "c1", input: {} });
  stub.fire({ type: "tool_execution_end", toolName: "t", toolCallId: "c1" });
  stub.fire({ type: "tool_call", toolName: "t", toolCallId: "c1", input: {} });

  assert.equal(seenStates.length, 2);
  assert.notEqual(seenStates[1], seenStates[0], "执行结束后应释放并重建 state");
});

test("渲染桥行为：agent_end 清空全部状态 → 后续渲染用全新 state", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  /** @type {unknown[]} */
  const seenStates = [];
  const def = {
    renderCall: (args, theme, context) => {
      seenStates.push(context.state);
      return fakeComponent("ok");
    },
  };
  const stub = createRenderBridgeStub({
    extensionRunner: { getToolDefinition: () => def },
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  wrapper.onEvent(() => {});
  wrapper.start();

  stub.fire({ type: "tool_call", toolName: "t", toolCallId: "c1", input: {} });
  stub.fire({ type: "agent_end", sessionId: "s" });
  stub.fire({ type: "tool_call", toolName: "t", toolCallId: "c1", input: {} });

  assert.equal(seenStates.length, 2);
  assert.notEqual(seenStates[1], seenStates[0], "agent_end 后 state 应重建");
});

test("渲染桥行为：message_start/message_end（role=custom）经 getMessageRenderer 附加 renderedLines（阶段 C 行为）", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const stub = createRenderBridgeStub({
    extensionRunner: {
      getMessageRenderer: (customType) => (message, options, theme) =>
        fakeComponent(`⚠ ${message.customType}`),
    },
  });
  const wrapper = trackWrapper(t, new AgentSessionWrapper(stub.inner));
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  wrapper.onEvent((e) => events.push(e));
  wrapper.start();

  stub.fire({
    type: "message_start",
    message: { role: "custom", customType: "subagent-control", content: [] },
  });
  stub.fire({
    type: "message_end",
    message: { role: "custom", customType: "subagent-control", content: [] },
  });
  // 非 custom 消息不附加
  stub.fire({
    type: "message_end",
    message: { role: "assistant", content: [] },
  });

  assert.equal(events.length, 3);
  assert.ok(events[0].renderedLines?.some((line) => line.includes("⚠ subagent-control")));
  assert.ok(events[1].renderedLines?.some((line) => line.includes("⚠ subagent-control")));
  assert.equal("renderedLines" in events[2], false, "非 custom 消息不附加渲染行");

  // 无渲染器（getMessageRenderer 缺失）→ 事件原样
  const stubNoRenderer = createRenderBridgeStub({ extensionRunner: {} });
  const wrapperNo = trackWrapper(t, new AgentSessionWrapper(stubNoRenderer.inner));
  /** @type {Array<Record<string, unknown>>} */
  const eventsNo = [];
  wrapperNo.onEvent((e) => eventsNo.push(e));
  wrapperNo.start();
  stubNoRenderer.fire({
    type: "message_start",
    message: { role: "custom", customType: "x", content: [] },
  });
  assert.equal("renderedLines" in eventsNo[0], false, "无渲染器事件原样");
});
