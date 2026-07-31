/**
 * 未读会话 id 的 localStorage 读写。
 * 与 SessionSidebar 解耦，便于 node:test 注入 storage。
 */

export const UNREAD_SESSIONS_STORAGE_KEY = "pidance:unread-session-ids";

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

/** 加载未读会话 id：仅读规范键；损坏输入安全回退空集合。 */
export function loadUnreadSessionIdsFromStorage(storage: StorageLike): Set<string> {
  try {
    return parseUnreadSessionIds(storage.getItem(UNREAD_SESSIONS_STORAGE_KEY));
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
