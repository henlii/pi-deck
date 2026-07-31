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

  await wrapper.send({ type: "prompt", message: "hi" });
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
  await wrapper.send({ type: "prompt", message: "x", streamingBehavior: "steer" });
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(stub.appended.length, 1);
  assertMetadataEqual(stub.appended[0].data.metadata, { streamingBehavior: "steer" });
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

  await wrapper.send({ type: "prompt", message: "x" });
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
