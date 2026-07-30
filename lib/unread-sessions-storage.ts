/**
 * 未读会话 id 的 localStorage 读写与 pi-deck → pidance 一次性迁移。
 * 与 SessionSidebar 解耦，便于 node:test 注入 storage。
 */

export const UNREAD_SESSIONS_STORAGE_KEY = "pidance:unread-session-ids";
export const LEGACY_UNREAD_SESSIONS_STORAGE_KEY = "pi-deck:unread-session-ids";

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function parseUnreadSessionIds(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

/**
 * 加载未读会话 id：新键存在则只读新键；否则一次性迁移旧键。
 * 空集合也会先写入规范 `[]` 再删旧键，避免清空后刷新从旧键复活。
 * 仅在新键写入成功后删除旧键。
 */
export function loadUnreadSessionIdsFromStorage(storage: StorageLike): Set<string> {
  try {
    const raw = storage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (raw !== null) return parseUnreadSessionIds(raw);

    const legacy = storage.getItem(LEGACY_UNREAD_SESSIONS_STORAGE_KEY);
    if (legacy === null) return new Set();

    const ids = parseUnreadSessionIds(legacy);
    try {
      // 空集合也写 `[]` 作为迁移哨兵，再删旧键；后续 save 可删空新键。
      storage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
      storage.removeItem(LEGACY_UNREAD_SESSIONS_STORAGE_KEY);
    } catch {
      // 写新键失败：不删旧键
    }
    return ids;
  } catch {
    return new Set();
  }
}

export function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  return loadUnreadSessionIdsFromStorage(window.localStorage);
}

export function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}
