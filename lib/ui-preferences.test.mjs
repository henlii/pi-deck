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
    projectAliases: {},
    closedProjectRoots: [],
  });
});

test("偏好序列化往返：serialize → JSON.parse → parse 保持一致", async () => {
  const { parseSidebarPreferences, serializeSidebarPreferences } = await jiti.import("./ui-preferences.ts");
  const prefs = {
    displayMode: "compact",
    collapsedProjectRoots: ["/a", "/b"],
    collapsedWorktreePaths: ["/a-wt/feat"],
    projectAliases: {},
    closedProjectRoots: [],
  };
  assert.deepEqual(parseSidebarPreferences(JSON.parse(serializeSidebarPreferences(prefs))), prefs);
});

test("项目 alias 解析：过滤空 key、空 value 与非 string 项，key/value 均 trim", async () => {
  const { parseProjectAliases } = await jiti.import("./ui-preferences.ts");
  assert.deepEqual(parseProjectAliases({
    "/repo": "  主仓库  ",
    "  / spaced  ": "keep-key-trim",
    "/empty": "",
    "/blank": "   ",
    "/num": 42,
    "/null": null,
    "/obj": {},
    "": "orphan",
    "   ": "orphan-blank",
  }), {
    "/repo": "主仓库",
    "/ spaced": "keep-key-trim",
  });
  // 非对象输入一律回退空表。
  for (const raw of [null, undefined, "x", 7, true, ["/repo", "alias"]]) {
    assert.deepEqual(parseProjectAliases(raw), {});
  }
});

test("偏好解析：alias 与 closedProjectRoots 脏数据回退/过滤", async () => {
  const { parseSidebarPreferences } = await jiti.import("./ui-preferences.ts");
  const prefs = parseSidebarPreferences({
    displayMode: "compact",
    projectAliases: { "/repo": "别名", "/bad": 1 },
    closedProjectRoots: ["/closed", 2, null],
  });
  assert.deepEqual(prefs.projectAliases, { "/repo": "别名" });
  assert.deepEqual(prefs.closedProjectRoots, ["/closed"]);
});

test("偏好解析：旧版本数据（无 alias/closed 字段）回退为空", async () => {
  const { parseSidebarPreferences } = await jiti.import("./ui-preferences.ts");
  const prefs = parseSidebarPreferences({
    displayMode: "standard",
    collapsedProjectRoots: ["/repo"],
  });
  assert.deepEqual(prefs.projectAliases, {});
  assert.deepEqual(prefs.closedProjectRoots, []);
  assert.deepEqual(prefs.collapsedProjectRoots, ["/repo"]);
});

test("偏好序列化往返：alias 与 closed roots 一并保持", async () => {
  const { parseSidebarPreferences, serializeSidebarPreferences } = await jiti.import("./ui-preferences.ts");
  const prefs = {
    displayMode: "standard",
    collapsedProjectRoots: [],
    collapsedWorktreePaths: [],
    projectAliases: { "/repo": "主仓库", "/other": "实验" },
    closedProjectRoots: ["/archived"],
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

function makeMemoryStorage(initial = {}) {
  /** @type {Map<string, string>} */
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

test("侧栏偏好迁移：新键优先且不读/不删旧键", async () => {
  const {
    loadSidebarPreferencesFromStorage,
    STORAGE_KEY,
    LEGACY_STORAGE_KEY,
    serializeSidebarPreferences,
  } = await jiti.import("./ui-preferences.ts");
  const newPrefs = {
    displayMode: "compact",
    collapsedProjectRoots: ["/new"],
    collapsedWorktreePaths: [],
    projectAliases: {},
    closedProjectRoots: [],
  };
  const legacyPrefs = {
    displayMode: "standard",
    collapsedProjectRoots: ["/legacy"],
    collapsedWorktreePaths: [],
    projectAliases: {},
    closedProjectRoots: [],
  };
  const storage = makeMemoryStorage({
    [STORAGE_KEY]: serializeSidebarPreferences(newPrefs),
    [LEGACY_STORAGE_KEY]: serializeSidebarPreferences(legacyPrefs),
  });
  assert.deepEqual(loadSidebarPreferencesFromStorage(storage), newPrefs);
  assert.equal(storage.map.has(LEGACY_STORAGE_KEY), true);
  assert.equal(storage.map.get(LEGACY_STORAGE_KEY), serializeSidebarPreferences(legacyPrefs));
});

test("侧栏偏好迁移：成功迁移后删除旧键", async () => {
  const {
    loadSidebarPreferencesFromStorage,
    STORAGE_KEY,
    LEGACY_STORAGE_KEY,
    serializeSidebarPreferences,
  } = await jiti.import("./ui-preferences.ts");
  const legacyPrefs = {
    displayMode: "compact",
    collapsedProjectRoots: ["/a"],
    collapsedWorktreePaths: ["/wt"],
    projectAliases: { "/a": "别名" },
    closedProjectRoots: [],
  };
  const storage = makeMemoryStorage({
    [LEGACY_STORAGE_KEY]: serializeSidebarPreferences(legacyPrefs),
  });
  assert.deepEqual(loadSidebarPreferencesFromStorage(storage), legacyPrefs);
  assert.equal(storage.map.has(LEGACY_STORAGE_KEY), false);
  assert.equal(storage.map.get(STORAGE_KEY), serializeSidebarPreferences(legacyPrefs));
});

test("侧栏偏好迁移：写新键失败不删旧键", async () => {
  const {
    loadSidebarPreferencesFromStorage,
    STORAGE_KEY,
    LEGACY_STORAGE_KEY,
    serializeSidebarPreferences,
  } = await jiti.import("./ui-preferences.ts");
  const legacyPrefs = {
    displayMode: "compact",
    collapsedProjectRoots: ["/a"],
    collapsedWorktreePaths: [],
    projectAliases: {},
    closedProjectRoots: [],
  };
  const map = new Map([[LEGACY_STORAGE_KEY, serializeSidebarPreferences(legacyPrefs)]]);
  const storage = {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem() {
      throw new Error("quota");
    },
    removeItem(key) {
      map.delete(key);
    },
  };
  assert.deepEqual(loadSidebarPreferencesFromStorage(storage), legacyPrefs);
  assert.equal(map.has(LEGACY_STORAGE_KEY), true);
  assert.equal(map.has(STORAGE_KEY), false);
});
