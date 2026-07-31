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

test("unread：读取规范键", async () => {
  const {
    loadUnreadSessionIdsFromStorage,
    UNREAD_SESSIONS_STORAGE_KEY,
  } = await jiti.import("./unread-sessions-storage.ts");
  const storage = makeMemoryStorage({
    [UNREAD_SESSIONS_STORAGE_KEY]: JSON.stringify(["a", "b"]),
  });
  assert.deepEqual([...loadUnreadSessionIdsFromStorage(storage)].sort(), ["a", "b"]);
});

test("unread：缺失或损坏输入回退空集合", async () => {
  const { loadUnreadSessionIdsFromStorage, UNREAD_SESSIONS_STORAGE_KEY } = await jiti.import("./unread-sessions-storage.ts");
  assert.deepEqual([...loadUnreadSessionIdsFromStorage(makeMemoryStorage())], []);
  const storage = makeMemoryStorage({ [UNREAD_SESSIONS_STORAGE_KEY]: "{not-json" });
  assert.deepEqual([...loadUnreadSessionIdsFromStorage(storage)], []);
});
