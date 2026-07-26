import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("偏好解析：standard/compact 原样保留，非法 displayMode 回退 standard", async () => {
  const { parseSidebarPreferences } = await jiti.import("./ui-preferences.ts");
  assert.equal(parseSidebarPreferences({ displayMode: "standard" }).displayMode, "standard");
  assert.equal(parseSidebarPreferences({ displayMode: "compact" }).displayMode, "compact");
  assert.equal(parseSidebarPreferences({ displayMode: "minimal" }).displayMode, "standard");
  assert.equal(parseSidebarPreferences({ displayMode: 42 }).displayMode, "standard");
  assert.equal(parseSidebarPreferences({}).displayMode, "standard");
});

test("偏好解析：非对象输入回退完整默认值", async () => {
  const { parseSidebarPreferences, DEFAULT_SIDEBAR_PREFERENCES } = await jiti.import("./ui-preferences.ts");
  for (const raw of [null, undefined, "compact", 7, true, []]) {
    assert.deepEqual(parseSidebarPreferences(raw), DEFAULT_SIDEBAR_PREFERENCES);
  }
});

test("偏好解析：折叠集合逐项过滤非 string 脏数据", async () => {
  const { parseSidebarPreferences } = await jiti.import("./ui-preferences.ts");
  const prefs = parseSidebarPreferences({
    displayMode: "compact",
    collapsedProjectRoots: ["/repo", 1, null, "/other"],
    collapsedWorktreePaths: "not-an-array",
  });
  assert.deepEqual(prefs, {
    displayMode: "compact",
    collapsedProjectRoots: ["/repo", "/other"],
    collapsedWorktreePaths: [],
  });
});

test("偏好序列化往返：serialize → JSON.parse → parse 保持一致", async () => {
  const { parseSidebarPreferences, serializeSidebarPreferences } = await jiti.import("./ui-preferences.ts");
  const prefs = {
    displayMode: "compact",
    collapsedProjectRoots: ["/a", "/b"],
    collapsedWorktreePaths: ["/a-wt/feat"],
  };
  assert.deepEqual(parseSidebarPreferences(JSON.parse(serializeSidebarPreferences(prefs))), prefs);
});

test("无 window 环境：load 返回默认值、save 静默不抛", async () => {
  const { loadSidebarPreferences, saveSidebarPreferences, DEFAULT_SIDEBAR_PREFERENCES } = await jiti.import("./ui-preferences.ts");
  assert.equal(typeof window, "undefined");
  assert.deepEqual(loadSidebarPreferences(), DEFAULT_SIDEBAR_PREFERENCES);
  assert.doesNotThrow(() => saveSidebarPreferences({
    displayMode: "compact",
    collapsedProjectRoots: ["/a"],
    collapsedWorktreePaths: [],
  }));
});
