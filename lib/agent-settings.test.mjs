import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./agent-settings.ts");

test("parseAgentSettingsPatch：合法部分更新", () => {
  const r = mod.parseAgentSettingsPatch({
    defaultProvider: " new-api ",
    defaultModel: "grok-4.5",
    defaultThinkingLevel: "medium",
    compactionEnabled: false,
    retryEnabled: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.patch.defaultProvider, "new-api");
  assert.equal(r.patch.defaultModel, "grok-4.5");
  assert.equal(r.patch.defaultThinkingLevel, "medium");
  assert.equal(r.patch.compactionEnabled, false);
});

test("parseAgentSettingsPatch：拒绝 steeringMode/followUpMode（已固定 all）", () => {
  const steer = mod.parseAgentSettingsPatch({ steeringMode: "all" });
  assert.equal(steer.ok, false);
  assert.ok(steer.errors.some((e) => e.field === "steeringMode"));

  const follow = mod.parseAgentSettingsPatch({ followUpMode: "one-at-a-time" });
  assert.equal(follow.ok, false);
  assert.ok(follow.errors.some((e) => e.field === "followUpMode"));
});

test("parseAgentSettingsPatch：拒绝未知键与坏类型", () => {
  const unknown = mod.parseAgentSettingsPatch({ theme: "dark" });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((e) => e.field === "theme"));

  const badLevel = mod.parseAgentSettingsPatch({ defaultThinkingLevel: "ultra" });
  assert.equal(badLevel.ok, false);

  const empty = mod.parseAgentSettingsPatch({});
  assert.equal(empty.ok, false);

  const notObj = mod.parseAgentSettingsPatch(null);
  assert.equal(notObj.ok, false);
});

test("parseAgentSettingsPatch：空字符串 provider/model 拒绝", () => {
  const r = mod.parseAgentSettingsPatch({ defaultProvider: "  " });
  assert.equal(r.ok, false);
});

test("parseAgentSettingsPatch：null provider/model 拒绝（B2 回归）", () => {
  const providerNull = mod.parseAgentSettingsPatch({ defaultProvider: null });
  assert.equal(providerNull.ok, false);
  assert.ok(providerNull.errors.some((e) => e.field === "defaultProvider"));

  const modelNull = mod.parseAgentSettingsPatch({ defaultModel: null });
  assert.equal(modelNull.ok, false);
  assert.ok(modelNull.errors.some((e) => e.field === "defaultModel"));

  // 同时设两个，只要有一个 null 即失败
  const both = mod.parseAgentSettingsPatch({ defaultProvider: null, defaultModel: null });
  assert.equal(both.ok, false);
  assert.ok(both.errors.some((e) => e.field === "defaultProvider"));
  assert.ok(both.errors.some((e) => e.field === "defaultModel"));
});

test("projectAgentSettingsView + applyAgentSettingsPatch", async () => {
  const state = {
    defaultProvider: "anthropic",
    defaultModel: "claude",
    defaultThinkingLevel: "low",
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
    projectTrusted: true,
    flushed: 0,
  };

  const manager = {
    getDefaultProvider: () => state.defaultProvider,
    getDefaultModel: () => state.defaultModel,
    getDefaultThinkingLevel: () => state.defaultThinkingLevel,
    getSteeringMode: () => state.steeringMode,
    getFollowUpMode: () => state.followUpMode,
    getCompactionSettings: () => ({ ...state.compaction }),
    getRetrySettings: () => ({ ...state.retry }),
    isProjectTrusted: () => state.projectTrusted,
    setDefaultProvider: (p) => {
      state.defaultProvider = p;
    },
    setDefaultModel: (m) => {
      state.defaultModel = m;
    },
    setDefaultModelAndProvider: (p, m) => {
      state.defaultProvider = p;
      state.defaultModel = m;
    },
    setDefaultThinkingLevel: (l) => {
      state.defaultThinkingLevel = l;
    },
    setSteeringMode: (m) => {
      state.steeringMode = m;
    },
    setFollowUpMode: (m) => {
      state.followUpMode = m;
    },
    setCompactionEnabled: (e) => {
      state.compaction.enabled = e;
    },
    setRetryEnabled: (e) => {
      state.retry.enabled = e;
    },
    flush: async () => {
      state.flushed += 1;
    },
  };

  const view = mod.projectAgentSettingsView(manager);
  assert.equal(view.defaultProvider, "anthropic");
  assert.equal(view.compaction.reserveTokens, 16384);
  assert.equal(view.scope, "global");

  const next = await mod.applyAgentSettingsPatch(manager, {
    defaultProvider: "new-api",
    defaultModel: "grok-4.5",
    defaultThinkingLevel: "high",
    compactionEnabled: false,
    retryEnabled: false,
  });
  assert.equal(state.defaultProvider, "new-api");
  assert.equal(state.defaultModel, "grok-4.5");
  assert.equal(state.defaultThinkingLevel, "high");
  assert.equal(state.compaction.enabled, false);
  assert.equal(state.retry.enabled, false);
  // 任何保存都强制队列模式为 all
  assert.equal(state.steeringMode, "all");
  assert.equal(state.followUpMode, "all");
  assert.equal(state.flushed, 1);
  assert.equal(next.compaction.enabled, false);
  // 只读数值未被 patch 改写
  assert.equal(next.compaction.reserveTokens, 16384);
  assert.equal(next.retry.maxRetries, 3);
});

test("applyAgentSettingsPatch：thinking null → off", async () => {
  const state = {
    defaultThinkingLevel: "medium",
    flushed: 0,
    compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 2 },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
  };
  const manager = {
    getDefaultProvider: () => undefined,
    getDefaultModel: () => undefined,
    getDefaultThinkingLevel: () => state.defaultThinkingLevel,
    getSteeringMode: () => "one-at-a-time",
    getFollowUpMode: () => "one-at-a-time",
    getCompactionSettings: () => ({ ...state.compaction }),
    getRetrySettings: () => ({ ...state.retry }),
    isProjectTrusted: () => false,
    setDefaultProvider: () => {},
    setDefaultModel: () => {},
    setDefaultModelAndProvider: () => {},
    setDefaultThinkingLevel: (l) => {
      state.defaultThinkingLevel = l;
    },
    setSteeringMode: () => {},
    setFollowUpMode: () => {},
    setCompactionEnabled: () => {},
    setRetryEnabled: () => {},
    flush: async () => {
      state.flushed += 1;
    },
  };
  await mod.applyAgentSettingsPatch(manager, { defaultThinkingLevel: null });
  assert.equal(state.defaultThinkingLevel, "off");
});

