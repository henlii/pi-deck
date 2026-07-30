/**
 * session-activity-events：映射全分支 + best-effort + notify 单一 owner。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

/** @returns {Promise<typeof import("./session-activity-events.ts")>} */
async function loadEvents() {
  return jiti.import("./session-activity-events.ts");
}

/** @returns {Promise<typeof import("./session-activity.ts")>} */
async function loadActivity() {
  return jiti.import("./session-activity.ts");
}

// ---------------------------------------------------------------------------
// mapPromptErrorToActivity
// ---------------------------------------------------------------------------

test("mapPromptErrorToActivity：基础字段与 source", async () => {
  const { mapPromptErrorToActivity } = await loadEvents();
  assert.deepEqual(mapPromptErrorToActivity({ errorMessage: "boom" }), {
    kind: "error",
    title: "Prompt failed",
    content: "boom",
    source: "rpc.prompt_error",
  });
});

test("mapPromptErrorToActivity：streamingBehavior 有值才写入 metadata", async () => {
  const { mapPromptErrorToActivity } = await loadEvents();
  assert.deepEqual(
    mapPromptErrorToActivity({ errorMessage: "x", streamingBehavior: "steer" }),
    {
      kind: "error",
      title: "Prompt failed",
      content: "x",
      source: "rpc.prompt_error",
      metadata: { streamingBehavior: "steer" },
    },
  );
  assert.deepEqual(
    mapPromptErrorToActivity({ errorMessage: "x", streamingBehavior: "followUp" }),
    {
      kind: "error",
      title: "Prompt failed",
      content: "x",
      source: "rpc.prompt_error",
      metadata: { streamingBehavior: "followUp" },
    },
  );
  // 未传 streamingBehavior → 无 metadata
  const bare = mapPromptErrorToActivity({ errorMessage: "x" });
  assert.equal(bare.metadata, undefined);
});

// ---------------------------------------------------------------------------
// mapExtensionErrorToActivity
// ---------------------------------------------------------------------------

test("mapExtensionErrorToActivity：基础与可选 metadata", async () => {
  const { mapExtensionErrorToActivity } = await loadEvents();
  assert.deepEqual(mapExtensionErrorToActivity({ error: "e1" }), {
    kind: "error",
    title: "Extension error",
    content: "e1",
    source: "extension_error",
  });

  assert.deepEqual(
    mapExtensionErrorToActivity({
      error: "e2",
      extensionPath: "/ext/a.ts",
      event: "session_start",
    }),
    {
      kind: "error",
      title: "Extension error",
      content: "e2",
      source: "extension_error",
      metadata: { extensionPath: "/ext/a.ts", event: "session_start" },
    },
  );

  // 空字符串 path/event 不入 metadata
  assert.deepEqual(
    mapExtensionErrorToActivity({ error: "e3", extensionPath: "", event: "" }),
    {
      kind: "error",
      title: "Extension error",
      content: "e3",
      source: "extension_error",
    },
  );

  // 仅 path
  assert.deepEqual(
    mapExtensionErrorToActivity({ error: "e4", extensionPath: "/p" }),
    {
      kind: "error",
      title: "Extension error",
      content: "e4",
      source: "extension_error",
      metadata: { extensionPath: "/p" },
    },
  );
});

// ---------------------------------------------------------------------------
// mapExtensionNotifyToActivity
// ---------------------------------------------------------------------------

test("mapExtensionNotifyToActivity：仅 warning/error；其它 null", async () => {
  const { mapExtensionNotifyToActivity } = await loadEvents();

  assert.deepEqual(
    mapExtensionNotifyToActivity({
      message: "w",
      notifyType: "warning",
      requestId: "r1",
    }),
    {
      kind: "warning",
      title: "Extension warning",
      content: "w",
      source: "extension.ui.notify",
      requestId: "r1",
      metadata: { notifyType: "warning" },
    },
  );

  assert.deepEqual(
    mapExtensionNotifyToActivity({
      message: "err",
      notifyType: "error",
      requestId: "r2",
    }),
    {
      kind: "error",
      title: "Extension error",
      content: "err",
      source: "extension.ui.notify",
      requestId: "r2",
      metadata: { notifyType: "error" },
    },
  );

  assert.equal(
    mapExtensionNotifyToActivity({ message: "i", notifyType: "info", requestId: "r" }),
    null,
  );
  assert.equal(
    mapExtensionNotifyToActivity({ message: "s", notifyType: "success", requestId: "r" }),
    null,
  );
  assert.equal(
    mapExtensionNotifyToActivity({ message: "d", requestId: "r" }),
    null,
  );
  assert.equal(
    mapExtensionNotifyToActivity({ message: "u", notifyType: "unknown", requestId: "r" }),
    null,
  );
});

// ---------------------------------------------------------------------------
// tryAppendActivityBestEffort
// ---------------------------------------------------------------------------

test("tryAppendActivityBestEffort：null 不调用 append", async () => {
  const { tryAppendActivityBestEffort } = await loadEvents();
  let calls = 0;
  assert.equal(
    tryAppendActivityBestEffort(() => {
      calls += 1;
    }, null),
    false,
  );
  assert.equal(calls, 0);
});

test("tryAppendActivityBestEffort：成功返回 true", async () => {
  const { tryAppendActivityBestEffort } = await loadEvents();
  const seen = [];
  assert.equal(
    tryAppendActivityBestEffort((input) => {
      seen.push(input);
    }, { kind: "error", title: "t", content: "c" }),
    true,
  );
  assert.equal(seen.length, 1);
});

test("tryAppendActivityBestEffort：抛错吞掉返回 false，不递归", async () => {
  const { tryAppendActivityBestEffort } = await loadEvents();
  let calls = 0;
  assert.equal(
    tryAppendActivityBestEffort(() => {
      calls += 1;
      throw new Error("disk full");
    }, { kind: "error", title: "t", content: "c" }),
    false,
  );
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// persistExtensionNotify owner
// ---------------------------------------------------------------------------

test("persistExtensionNotify：warning/error 各写一次；info 不写", async () => {
  const { createNotifyPersistState, persistExtensionNotify } = await loadEvents();
  const state = createNotifyPersistState();
  const appended = [];
  const append = (input) => {
    appended.push(input);
  };

  assert.equal(
    persistExtensionNotify(state, append, {
      message: "w",
      notifyType: "warning",
      requestId: "id-w",
    }),
    true,
  );
  assert.equal(
    persistExtensionNotify(state, append, {
      message: "e",
      notifyType: "error",
      requestId: "id-e",
    }),
    true,
  );
  assert.equal(
    persistExtensionNotify(state, append, {
      message: "i",
      notifyType: "info",
      requestId: "id-i",
    }),
    false,
  );
  assert.equal(
    persistExtensionNotify(state, append, {
      message: "s",
      notifyType: "success",
      requestId: "id-s",
    }),
    false,
  );
  assert.equal(
    persistExtensionNotify(state, append, {
      message: "d",
      requestId: "id-d",
    }),
    false,
  );

  assert.equal(appended.length, 2);
  assert.equal(appended[0].kind, "warning");
  assert.equal(appended[0].requestId, "id-w");
  assert.equal(appended[1].kind, "error");
  assert.equal(appended[1].requestId, "id-e");
});

test("persistExtensionNotify：同 requestId 二次只写一次", async () => {
  const { createNotifyPersistState, persistExtensionNotify } = await loadEvents();
  const state = createNotifyPersistState();
  const appended = [];
  const append = (input) => {
    appended.push(input);
  };

  assert.equal(
    persistExtensionNotify(state, append, {
      message: "same",
      notifyType: "warning",
      requestId: "dup",
    }),
    true,
  );
  assert.equal(
    persistExtensionNotify(state, append, {
      message: "same again",
      notifyType: "warning",
      requestId: "dup",
    }),
    false,
  );
  assert.equal(appended.length, 1);
  assert.equal(appended[0].content, "same");
});

test("persistExtensionNotify：不同 id 同文案各写一次", async () => {
  const { createNotifyPersistState, persistExtensionNotify } = await loadEvents();
  const state = createNotifyPersistState();
  const appended = [];
  const append = (input) => {
    appended.push(input);
  };

  assert.equal(
    persistExtensionNotify(state, append, {
      message: "same text",
      notifyType: "error",
      requestId: "a",
    }),
    true,
  );
  assert.equal(
    persistExtensionNotify(state, append, {
      message: "same text",
      notifyType: "error",
      requestId: "b",
    }),
    true,
  );
  assert.equal(appended.length, 2);
  assert.equal(appended[0].requestId, "a");
  assert.equal(appended[1].requestId, "b");
});

test("persistExtensionNotify：失败不 remember，同 id 可重试一次", async () => {
  const { createNotifyPersistState, persistExtensionNotify } = await loadEvents();
  const state = createNotifyPersistState();
  const appended = [];
  let failOnce = true;
  const append = (input) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("transient");
    }
    appended.push(input);
  };

  assert.equal(
    persistExtensionNotify(state, append, {
      message: "retry me",
      notifyType: "warning",
      requestId: "retry-id",
    }),
    false,
  );
  assert.equal(appended.length, 0);

  assert.equal(
    persistExtensionNotify(state, append, {
      message: "retry me",
      notifyType: "warning",
      requestId: "retry-id",
    }),
    true,
  );
  assert.equal(appended.length, 1);

  // 成功后同 id 不再写
  assert.equal(
    persistExtensionNotify(state, append, {
      message: "retry me",
      notifyType: "warning",
      requestId: "retry-id",
    }),
    false,
  );
  assert.equal(appended.length, 1);
});

test("persistExtensionNotify：有界 FIFO，超出 max 后最早 id 可再写", async () => {
  const { createNotifyPersistState, persistExtensionNotify } = await loadEvents();
  const state = createNotifyPersistState(2);
  const appended = [];
  const append = (input) => {
    appended.push(input);
  };

  assert.equal(
    persistExtensionNotify(state, append, {
      message: "1",
      notifyType: "warning",
      requestId: "n1",
    }),
    true,
  );
  assert.equal(
    persistExtensionNotify(state, append, {
      message: "2",
      notifyType: "warning",
      requestId: "n2",
    }),
    true,
  );
  // n1 被挤出
  assert.equal(
    persistExtensionNotify(state, append, {
      message: "3",
      notifyType: "warning",
      requestId: "n3",
    }),
    true,
  );
  // n1 可再写
  assert.equal(
    persistExtensionNotify(state, append, {
      message: "1-again",
      notifyType: "warning",
      requestId: "n1",
    }),
    true,
  );
  // n2 仍在集合中（n1 挤出后 n2、n3 在；再写 n1 挤出 n2）
  // 当前集合应含 n3, n1
  assert.equal(
    persistExtensionNotify(state, append, {
      message: "3-again",
      notifyType: "warning",
      requestId: "n3",
    }),
    false,
  );
  assert.equal(appended.length, 4);
});

test("persistExtensionNotify：空 requestId 拒绝", async () => {
  const { createNotifyPersistState, persistExtensionNotify } = await loadEvents();
  const state = createNotifyPersistState();
  let calls = 0;
  assert.equal(
    persistExtensionNotify(state, () => {
      calls += 1;
    }, { message: "x", notifyType: "warning", requestId: "" }),
    false,
  );
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// 与 normalize 的 fail-closed 契约（不截断）
// ---------------------------------------------------------------------------

test("映射超长 content 不截断；normalize fail closed", async () => {
  const { mapPromptErrorToActivity, mapExtensionErrorToActivity, mapExtensionNotifyToActivity } =
    await loadEvents();
  const { normalizeActivityInput, ACTIVITY_CONTENT_MAX, ACTIVITY_METADATA_STRING_MAX } =
    await loadActivity();

  const longContent = "x".repeat(ACTIVITY_CONTENT_MAX + 1);
  const promptMapped = mapPromptErrorToActivity({ errorMessage: longContent });
  assert.equal(promptMapped.content.length, ACTIVITY_CONTENT_MAX + 1);
  assert.throws(() => normalizeActivityInput(promptMapped), /content exceeds/);

  const extMapped = mapExtensionErrorToActivity({ error: longContent });
  assert.equal(extMapped.content.length, ACTIVITY_CONTENT_MAX + 1);
  assert.throws(() => normalizeActivityInput(extMapped), /content exceeds/);

  const notifyMapped = mapExtensionNotifyToActivity({
    message: longContent,
    notifyType: "error",
    requestId: "rid",
  });
  assert.ok(notifyMapped);
  assert.equal(notifyMapped.content.length, ACTIVITY_CONTENT_MAX + 1);
  assert.throws(() => normalizeActivityInput(notifyMapped), /content exceeds/);

  // metadata 超长字符串也不截断
  const longPath = "p".repeat(ACTIVITY_METADATA_STRING_MAX + 1);
  const metaMapped = mapExtensionErrorToActivity({
    error: "e",
    extensionPath: longPath,
  });
  assert.equal(metaMapped.metadata?.extensionPath?.length, ACTIVITY_METADATA_STRING_MAX + 1);
  assert.throws(() => normalizeActivityInput(metaMapped), /metadata string exceeds/);
});

test("tryAppendActivityBestEffort：normalize 失败时返回 false", async () => {
  const { mapPromptErrorToActivity, tryAppendActivityBestEffort } = await loadEvents();
  const { normalizeActivityInput, ACTIVITY_CONTENT_MAX } = await loadActivity();

  const long = mapPromptErrorToActivity({
    errorMessage: "z".repeat(ACTIVITY_CONTENT_MAX + 50),
  });
  let calls = 0;
  const ok = tryAppendActivityBestEffort((input) => {
    calls += 1;
    normalizeActivityInput(input); // 模拟 appendActivity 内 normalize
  }, long);
  assert.equal(ok, false);
  assert.equal(calls, 1);
});
