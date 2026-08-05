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

/** 右侧内容面板可调宽边界；不包含最右侧常驻 44px 图标栏。 */
export const RIGHT_PANEL_WIDTH_MIN = 320;
export const RIGHT_PANEL_WIDTH_MAX = 720;
export const RIGHT_PANEL_WIDTH_DEFAULT = 400;

/**
 * 将任意输入钳到侧栏宽度合法范围；非有限数回退默认。
 * 解析与写入共用，保证持久化值始终可渲染。
 */
export function clampSidebarWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
}

/**
 * 将任意输入钳到右栏宽度合法范围；非有限数回退默认。
 * 解析与写入共用，保证持久化值始终可渲染。
 */
export function clampRightPanelWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return RIGHT_PANEL_WIDTH_DEFAULT;
  return Math.min(RIGHT_PANEL_WIDTH_MAX, Math.max(RIGHT_PANEL_WIDTH_MIN, Math.round(value)));
}

/** 容错解析右栏开/关：仅接受显式 boolean true，其余（含旧数据缺字段）一律关闭。 */
export function parseRightPanelOpen(value: unknown): boolean {
  return value === true;
}

/**
 * 容错解析「最近会话区」开/关：默认开启；仅显式 boolean false 才关闭。
 * 旧数据缺字段 / 脏数据（0、"false" 等）一律保持默认开启。
 */
export function parseShowRecentSessions(value: unknown): boolean {
  return value !== false;
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
  /** 右侧内容面板开/关；图标栏不受此偏好影响并始终常驻。 */
  rightPanelOpen: boolean;
  /** 右侧内容面板宽度（px，不含图标栏）；损坏/越界值解析时 clamp。 */
  rightPanelWidth: number;
  /** 「最近会话」区开/关（项目列表上方的快捷入口）；默认开启。 */
  showRecentSessions: boolean;
}

export const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  displayMode: "standard",
  collapsedProjectRoots: [],
  collapsedWorktreePaths: [],
  projectAliases: {},
  closedProjectRoots: [],
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  rightPanelOpen: false,
  rightPanelWidth: RIGHT_PANEL_WIDTH_DEFAULT,
  showRecentSessions: true,
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
    // 旧数据无右栏字段：右栏默认关闭、宽度默认。
    rightPanelOpen: parseRightPanelOpen(record.rightPanelOpen),
    rightPanelWidth: clampRightPanelWidth(record.rightPanelWidth),
    // 旧数据无最近会话字段：默认开启（仅显式 false 关闭）。
    showRecentSessions: parseShowRecentSessions(record.showRecentSessions),
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
    rightPanelOpen: parseRightPanelOpen(prefs.rightPanelOpen),
    rightPanelWidth: clampRightPanelWidth(prefs.rightPanelWidth),
    showRecentSessions: parseShowRecentSessions(prefs.showRecentSessions),
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

/**
 * 只更新存储中的右栏开/关与宽度（read-modify-write），其余字段原样保留。
 * 右栏偏好的唯一 owner 是 AppShell（布局 owner）；其它写入不得经此函数。
 */
export function saveRightPanelPreferencesToStorage(
  storage: StorageLike,
  patch: { open?: boolean; width?: number },
): void {
  try {
    const current = loadSidebarPreferencesFromStorage(storage);
    storage.setItem(STORAGE_KEY, serializeSidebarPreferences({
      ...current,
      rightPanelOpen: patch.open === undefined ? current.rightPanelOpen : parseRightPanelOpen(patch.open),
      rightPanelWidth: patch.width === undefined ? current.rightPanelWidth : clampRightPanelWidth(patch.width),
    }));
  } catch {
    // 忽略存储配额 / 隐私模式错误
  }
}

/** SSR / 无 localStorage 环境安全 no-op。 */
export function saveRightPanelPreferences(patch: { open?: boolean; width?: number }): void {
  if (typeof window === "undefined") return;
  saveRightPanelPreferencesToStorage(window.localStorage, patch);
}
