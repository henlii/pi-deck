import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

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

test("unread 迁移：新键优先且不读/不删旧键", async () => {
  const {
    loadUnreadSessionIdsFromStorage,
    UNREAD_SESSIONS_STORAGE_KEY,
    LEGACY_UNREAD_SESSIONS_STORAGE_KEY,
  } = await jiti.import("./unread-sessions-storage.ts");
  const storage = makeMemoryStorage({
    [UNREAD_SESSIONS_STORAGE_KEY]: JSON.stringify(["new-id"]),
    [LEGACY_UNREAD_SESSIONS_STORAGE_KEY]: JSON.stringify(["legacy-id"]),
  });
  assert.deepEqual([...loadUnreadSessionIdsFromStorage(storage)], ["new-id"]);
  assert.equal(storage.map.has(LEGACY_UNREAD_SESSIONS_STORAGE_KEY), true);
  assert.equal(storage.map.get(LEGACY_UNREAD_SESSIONS_STORAGE_KEY), JSON.stringify(["legacy-id"]));
});

test("unread 迁移：成功迁移后删除旧键", async () => {
  const {
    loadUnreadSessionIdsFromStorage,
    UNREAD_SESSIONS_STORAGE_KEY,
    LEGACY_UNREAD_SESSIONS_STORAGE_KEY,
  } = await jiti.import("./unread-sessions-storage.ts");
  const storage = makeMemoryStorage({
    [LEGACY_UNREAD_SESSIONS_STORAGE_KEY]: JSON.stringify(["a", "b"]),
  });
  assert.deepEqual([...loadUnreadSessionIdsFromStorage(storage)].sort(), ["a", "b"]);
  assert.equal(storage.map.has(LEGACY_UNREAD_SESSIONS_STORAGE_KEY), false);
  assert.equal(storage.map.get(UNREAD_SESSIONS_STORAGE_KEY), JSON.stringify(["a", "b"]));
});

test("unread 迁移：写新键失败不删旧键", async () => {
  const {
    loadUnreadSessionIdsFromStorage,
    UNREAD_SESSIONS_STORAGE_KEY,
    LEGACY_UNREAD_SESSIONS_STORAGE_KEY,
  } = await jiti.import("./unread-sessions-storage.ts");
  const map = new Map([[LEGACY_UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify(["x"])]]);
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
  assert.deepEqual([...loadUnreadSessionIdsFromStorage(storage)], ["x"]);
  assert.equal(map.has(LEGACY_UNREAD_SESSIONS_STORAGE_KEY), true);
  assert.equal(map.has(UNREAD_SESSIONS_STORAGE_KEY), false);
});

test("unread 空值迁移：写规范 [] 后删旧键，避免复活", async () => {
  const {
    loadUnreadSessionIdsFromStorage,
    UNREAD_SESSIONS_STORAGE_KEY,
    LEGACY_UNREAD_SESSIONS_STORAGE_KEY,
  } = await jiti.import("./unread-sessions-storage.ts");
  const storage = makeMemoryStorage({
    [LEGACY_UNREAD_SESSIONS_STORAGE_KEY]: JSON.stringify([]),
  });
  assert.deepEqual([...loadUnreadSessionIdsFromStorage(storage)], []);
  assert.equal(storage.map.has(LEGACY_UNREAD_SESSIONS_STORAGE_KEY), false);
  assert.equal(storage.map.get(UNREAD_SESSIONS_STORAGE_KEY), "[]");

  // 模拟 save 清空：删新键后不应再从旧键复活
  storage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
  assert.deepEqual([...loadUnreadSessionIdsFromStorage(storage)], []);
  assert.equal(storage.map.has(LEGACY_UNREAD_SESSIONS_STORAGE_KEY), false);
});
