/**
 * 会话栏 UI 偏好 seam（跨刷新持久化）。
 *
 * 只放跨刷新偏好：显示模式、项目/worktree 折叠集合。
 * 搜索查询、搜索框开关、会话级 child 折叠均为组件瞬时态，绝不写入这里。
 * 读写容错：localStorage 不可用（隐私模式/SSR）时静默回退默认值。
 */

export type SidebarDisplayMode = "standard" | "compact";

export interface SidebarPreferences {
  displayMode: SidebarDisplayMode;
  /** 已折叠项目根路径（projectRoot）。 */
  collapsedProjectRoots: string[];
  /** 已折叠非主 worktree 路径。 */
  collapsedWorktreePaths: string[];
}

export const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  displayMode: "standard",
  collapsedProjectRoots: [],
  collapsedWorktreePaths: [],
};

const STORAGE_KEY = "pi-web:sidebar-preferences";

/** 仅接受合法 string 数组，逐项过滤非 string 脏数据。 */
function parsePathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * 容错解析持久化偏好：任何字段非法都回退该字段默认值，
 * 整体不是对象时回退完整默认。绝不抛异常。
 */
export function parseSidebarPreferences(raw: unknown): SidebarPreferences {
  if (raw === null || typeof raw !== "object") return { ...DEFAULT_SIDEBAR_PREFERENCES };
  const record = raw as Record<string, unknown>;
  return {
    displayMode: record.displayMode === "compact" || record.displayMode === "standard"
      ? record.displayMode
      : DEFAULT_SIDEBAR_PREFERENCES.displayMode,
    collapsedProjectRoots: parsePathList(record.collapsedProjectRoots),
    collapsedWorktreePaths: parsePathList(record.collapsedWorktreePaths),
  };
}

export function serializeSidebarPreferences(prefs: SidebarPreferences): string {
  return JSON.stringify({
    displayMode: prefs.displayMode,
    collapsedProjectRoots: prefs.collapsedProjectRoots,
    collapsedWorktreePaths: prefs.collapsedWorktreePaths,
  });
}

/** SSR / 无 localStorage 环境安全返回默认值。 */
export function loadSidebarPreferences(): SidebarPreferences {
  if (typeof window === "undefined") return { ...DEFAULT_SIDEBAR_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SIDEBAR_PREFERENCES };
    return parseSidebarPreferences(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_SIDEBAR_PREFERENCES };
  }
}

export function saveSidebarPreferences(prefs: SidebarPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeSidebarPreferences(prefs));
  } catch {
    // 忽略存储配额 / 隐私模式错误
  }
}
