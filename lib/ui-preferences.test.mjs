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
  const { parseSidebarPreferences, SIDEBAR_WIDTH_DEFAULT } = await jiti.import("./ui-preferences.ts");
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
    sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  });
});

test("偏好序列化往返：serialize → JSON.parse → parse 保持一致", async () => {
  const { parseSidebarPreferences, serializeSidebarPreferences, SIDEBAR_WIDTH_DEFAULT } = await jiti.import("./ui-preferences.ts");
  const prefs = {
    displayMode: "compact",
    collapsedProjectRoots: ["/a", "/b"],
    collapsedWorktreePaths: ["/a-wt/feat"],
    projectAliases: {},
    closedProjectRoots: [],
    sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
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

test("偏好解析：旧版本数据（无 alias/closed/sidebarWidth 字段）回退为空/默认宽", async () => {
  const { parseSidebarPreferences, SIDEBAR_WIDTH_DEFAULT } = await jiti.import("./ui-preferences.ts");
  const prefs = parseSidebarPreferences({
    displayMode: "standard",
    collapsedProjectRoots: ["/repo"],
  });
  assert.deepEqual(prefs.projectAliases, {});
  assert.deepEqual(prefs.closedProjectRoots, []);
  assert.deepEqual(prefs.collapsedProjectRoots, ["/repo"]);
  assert.equal(prefs.sidebarWidth, SIDEBAR_WIDTH_DEFAULT);
});

test("偏好解析：sidebarWidth 越界/损坏 clamp；合法值保留", async () => {
  const {
    parseSidebarPreferences,
    clampSidebarWidth,
    SIDEBAR_WIDTH_MIN,
    SIDEBAR_WIDTH_MAX,
    SIDEBAR_WIDTH_DEFAULT,
  } = await jiti.import("./ui-preferences.ts");
  assert.equal(clampSidebarWidth(100), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(9999), SIDEBAR_WIDTH_MAX);
  assert.equal(clampSidebarWidth("x"), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(NaN), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(320.6), 321);
  assert.equal(parseSidebarPreferences({ sidebarWidth: 100 }).sidebarWidth, SIDEBAR_WIDTH_MIN);
  assert.equal(parseSidebarPreferences({ sidebarWidth: 999 }).sidebarWidth, SIDEBAR_WIDTH_MAX);
  assert.equal(parseSidebarPreferences({ sidebarWidth: 360 }).sidebarWidth, 360);
  assert.equal(parseSidebarPreferences({ sidebarWidth: null }).sidebarWidth, SIDEBAR_WIDTH_DEFAULT);
});

test("偏好序列化往返：alias 与 closed roots 与 sidebarWidth 一并保持", async () => {
  const { parseSidebarPreferences, serializeSidebarPreferences } = await jiti.import("./ui-preferences.ts");
  const prefs = {
    displayMode: "standard",
    collapsedProjectRoots: [],
    collapsedWorktreePaths: [],
    projectAliases: { "/repo": "主仓库", "/other": "实验" },
    closedProjectRoots: ["/archived"],
    sidebarWidth: 360,
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
    projectAliases: {},
    closedProjectRoots: [],
    sidebarWidth: DEFAULT_SIDEBAR_PREFERENCES.sidebarWidth,
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




test("侧栏宽度写入：只更新 sidebarWidth，其余存储字段原样保留", async () => {
  const {
    loadSidebarPreferencesFromStorage,
    saveSidebarWidthToStorage,
    STORAGE_KEY,
    serializeSidebarPreferences,
  } = await jiti.import("./ui-preferences.ts");
  const existing = {
    displayMode: "compact",
    collapsedProjectRoots: ["/repo"],
    collapsedWorktreePaths: ["/repo-wt/feat"],
    projectAliases: { "/repo": "主仓" },
    closedProjectRoots: ["/closed"],
    sidebarWidth: 300,
  };
  const storage = makeMemoryStorage({
    [STORAGE_KEY]: serializeSidebarPreferences(existing),
  });
  saveSidebarWidthToStorage(storage, 420);
  assert.deepEqual(loadSidebarPreferencesFromStorage(storage), { ...existing, sidebarWidth: 420 });
});

test("侧栏宽度写入：越界/非法值钳入 [240, 520]，空存储从默认偏好起步", async () => {
  const {
    loadSidebarPreferencesFromStorage,
    saveSidebarWidthToStorage,
    DEFAULT_SIDEBAR_PREFERENCES,
    SIDEBAR_WIDTH_MIN,
    SIDEBAR_WIDTH_MAX,
  } = await jiti.import("./ui-preferences.ts");
  const storage = makeMemoryStorage();
  saveSidebarWidthToStorage(storage, 40);
  assert.equal(loadSidebarPreferencesFromStorage(storage).sidebarWidth, SIDEBAR_WIDTH_MIN);
  saveSidebarWidthToStorage(storage, 9999);
  assert.equal(loadSidebarPreferencesFromStorage(storage).sidebarWidth, SIDEBAR_WIDTH_MAX);
  saveSidebarWidthToStorage(storage, Number.NaN);
  assert.equal(loadSidebarPreferencesFromStorage(storage).sidebarWidth, DEFAULT_SIDEBAR_PREFERENCES.sidebarWidth);
  // 除宽度外其余字段保持默认（不因宽度写入产生脏数据）
  const prefs = loadSidebarPreferencesFromStorage(storage);
  assert.deepEqual(prefs, { ...DEFAULT_SIDEBAR_PREFERENCES, projectAliases: {} });
});

test("侧栏宽度写入：存储抛错时静默忽略", async () => {
  const { saveSidebarWidthToStorage } = await jiti.import("./ui-preferences.ts");
  const storage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
    removeItem() {},
  };
  assert.doesNotThrow(() => saveSidebarWidthToStorage(storage, 360));
});

test("侧栏偏好：读取规范键与缺失回退默认", async () => {
  const {
    loadSidebarPreferencesFromStorage,
    STORAGE_KEY,
    serializeSidebarPreferences,
    SIDEBAR_WIDTH_DEFAULT,
    DEFAULT_SIDEBAR_PREFERENCES,
  } = await jiti.import("./ui-preferences.ts");
  const prefs = {
    displayMode: "compact",
    collapsedProjectRoots: ["/a"],
    collapsedWorktreePaths: [],
    projectAliases: {},
    closedProjectRoots: [],
    sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  };
  const storage = makeMemoryStorage({ [STORAGE_KEY]: serializeSidebarPreferences(prefs) });
  assert.deepEqual(loadSidebarPreferencesFromStorage(storage), prefs);
  const empty = loadSidebarPreferencesFromStorage(makeMemoryStorage());
  assert.equal(empty.displayMode, DEFAULT_SIDEBAR_PREFERENCES.displayMode);
  assert.equal(empty.sidebarWidth, SIDEBAR_WIDTH_DEFAULT);
});
