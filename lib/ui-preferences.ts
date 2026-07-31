/**
 * 会话栏 UI 偏好 seam（跨刷新持久化）。
 *
 * 只放跨刷新偏好：显示模式、项目/worktree 折叠集合、侧栏宽度。
 * 搜索查询、搜索框开关、会话级 child 折叠、可见条数均为组件瞬时态，绝不写入这里。
 * 读写容错：localStorage 不可用（隐私模式/SSR）时静默回退默认值。
 */

export type SidebarDisplayMode = "standard" | "compact";

/** 项目显示名 alias：projectRoot → 用户命名。纯 UI 层数据，与 Pi schema/磁盘/Git 无关。 */
export type ProjectAliases = Record<string, string>;

/** 桌面侧栏可调宽边界：与右侧工作区同档，避免过窄挤压会话或过宽占屏。 */
export const SIDEBAR_WIDTH_MIN = 240;
export const SIDEBAR_WIDTH_MAX = 520;
export const SIDEBAR_WIDTH_DEFAULT = 300;

/**
 * 将任意输入钳到侧栏宽度合法范围；非有限数回退默认。
 * 解析与写入共用，保证持久化值始终可渲染。
 */
export function clampSidebarWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
}

export interface SidebarPreferences {
  displayMode: SidebarDisplayMode;
  /** 已折叠项目根路径（projectRoot）。 */
  collapsedProjectRoots: string[];
  /** 已折叠非主 worktree 路径。 */
  collapsedWorktreePaths: string[];
  /** 项目显示名 alias（projectRoot → 名称）；项目行与搜索共用。 */
  projectAliases: ProjectAliases;
  /** 已关闭项目根路径：仅从侧栏隐藏，不删除任何目录/会话/Git 数据。 */
  closedProjectRoots: string[];
  /** 桌面侧栏宽度（px）；损坏/越界值解析时 clamp。 */
  sidebarWidth: number;
}

export const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  displayMode: "standard",
  collapsedProjectRoots: [],
  collapsedWorktreePaths: [],
  projectAliases: {},
  closedProjectRoots: [],
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
};

export const STORAGE_KEY = "pidance:sidebar-preferences";

/** 可注入 storage，便于迁移单测。 */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** 仅接受合法 string 数组，逐项过滤非 string 脏数据。 */
function parsePathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * 容错解析项目 alias：仅接受纯对象；key 与 value 均 trim，
 * 过滤空 key、空 value 与任何非 string 项。绝不抛异常。
 */
export function parseProjectAliases(value: unknown): ProjectAliases {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: ProjectAliases = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== "string") continue;
    const key = rawKey.trim();
    const alias = rawValue.trim();
    if (!key || !alias) continue;
    result[key] = alias;
  }
  return result;
}

/**
 * 容错解析持久化偏好：任何字段非法都回退该字段默认值，
 * 整体不是对象时回退完整默认。绝不抛异常。
 */
export function parseSidebarPreferences(raw: unknown): SidebarPreferences {
  if (raw === null || typeof raw !== "object") {
    return {
      ...DEFAULT_SIDEBAR_PREFERENCES,
      projectAliases: {},
      closedProjectRoots: [],
      collapsedProjectRoots: [],
      collapsedWorktreePaths: [],
    };
  }
  const record = raw as Record<string, unknown>;
  return {
    displayMode: record.displayMode === "compact" || record.displayMode === "standard"
      ? record.displayMode
      : DEFAULT_SIDEBAR_PREFERENCES.displayMode,
    collapsedProjectRoots: parsePathList(record.collapsedProjectRoots),
    collapsedWorktreePaths: parsePathList(record.collapsedWorktreePaths),
    projectAliases: parseProjectAliases(record.projectAliases),
    closedProjectRoots: parsePathList(record.closedProjectRoots),
    // 旧数据缺字段时 clamp 非数字 → 默认 300；越界/损坏一律钳入 [min, max]。
    sidebarWidth: clampSidebarWidth(record.sidebarWidth),
  };
}

export function serializeSidebarPreferences(prefs: SidebarPreferences): string {
  return JSON.stringify({
    displayMode: prefs.displayMode,
    collapsedProjectRoots: prefs.collapsedProjectRoots,
    collapsedWorktreePaths: prefs.collapsedWorktreePaths,
    projectAliases: prefs.projectAliases,
    closedProjectRoots: prefs.closedProjectRoots,
    sidebarWidth: clampSidebarWidth(prefs.sidebarWidth),
  });
}

/**
 * 从 storage 加载侧栏偏好：仅读规范键；损坏输入安全回退默认。
 */
export function loadSidebarPreferencesFromStorage(storage: StorageLike): SidebarPreferences {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return parseSidebarPreferences(null);
    try {
      return parseSidebarPreferences(JSON.parse(raw) as unknown);
    } catch {
      return parseSidebarPreferences(null);
    }
  } catch {
    return parseSidebarPreferences(null);
  }
}

/** SSR / 无 localStorage 环境安全返回默认值。 */
export function loadSidebarPreferences(): SidebarPreferences {
  if (typeof window === "undefined") return parseSidebarPreferences(null);
  return loadSidebarPreferencesFromStorage(window.localStorage);
}

export function saveSidebarPreferences(prefs: SidebarPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeSidebarPreferences(prefs));
  } catch {
    // 忽略存储配额 / 隐私模式错误
  }
}

/**
 * 只更新存储中的 sidebarWidth（read-modify-write），其余字段原样保留。
 * sidebarWidth 的唯一 owner 是 AppShell（布局 owner）；侧栏其它偏好写入不得经此函数。
 */
export function saveSidebarWidthToStorage(storage: StorageLike, width: number): void {
  try {
    const current = loadSidebarPreferencesFromStorage(storage);
    storage.setItem(STORAGE_KEY, serializeSidebarPreferences({
      ...current,
      sidebarWidth: clampSidebarWidth(width),
    }));
  } catch {
    // 忽略存储配额 / 隐私模式错误
  }
}

/** SSR / 无 localStorage 环境安全 no-op。 */
export function saveSidebarWidth(width: number): void {
  if (typeof window === "undefined") return;
  saveSidebarWidthToStorage(window.localStorage, width);
}
