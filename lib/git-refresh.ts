import path from "path";

// ============================================================================
// Git 数据定向失效（P1-3，评估文档 68d7247a）
//
// 「事件 → 受影响路径集合 → 定向失效」的纯逻辑层：
//   - diff 缓存 key 按 (cwd, filePath) 拆分，单文件修改只失效对应条目；
//   - 受影响路径集合（SSE watch change / 文件保存等事件携带）命中文件时
//     才失效对应 diff，避免工具事件后全仓重抓；
//   - git status 与单文件 diff 分离缓存（status 由 /api/git/status 短 TTL 缓存，
//     diff 由 git-changes.ts 的 (cwd, filePath) 响应缓存管理，互不干扰）。
//
// 本层只提供纯函数与缓存条目选择器，不持有任何状态；缓存所有权在
// lib/git-changes.ts（服务端响应缓存）与 RightPanel（status state）。
// ============================================================================

/** diff 缓存 key：(cwd, filePath)。两字段用 NUL 连接避免路径边界歧义。 */
export function buildDiffCacheKey(cwd: string, filePath: string): string {
  return `${cwd}\u0000${filePath}`;
}

/** 归一化路径：去掉尾部路径分隔符，便于目录前缀匹配。 */
export function normalizePathForMatch(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, "");
  return normalized.length > 0 ? normalized : path.sep;
}

/**
 * 判断受影响路径是否命中候选文件：
 *   - 精确文件匹配（受影响路径即候选文件）；
 *   - 目录前缀匹配（受影响路径为候选文件的父目录，如 agent 写目录内多个文件）。
 * 跨平台兼容两种分隔符（Windows 路径在 POSIX 主机上也按统一逻辑比较）。
 */
export function affectedPathMatchesFile(affectedPath: string, candidateFile: string): boolean {
  const affected = normalizePathForMatch(affectedPath);
  const candidate = normalizePathForMatch(candidateFile);
  if (affected === candidate) return true;
  const prefix = `${affected}${path.sep}`;
  const altPrefix = `${affected}/`;
  return candidate.startsWith(prefix) || candidate.startsWith(altPrefix);
}

/** 受影响路径集合中是否有任一命中候选文件。 */
export function affectedPathsMatchFile(affectedPaths: readonly string[], candidateFile: string): boolean {
  return affectedPaths.some((affected) => affectedPathMatchesFile(affected, candidateFile));
}

/**
 * 受影响路径集合是否落在仓库内（用于判断工具事件是否涉及当前仓库，
 * 不涉及的 run 结束不刷新 status / 不失效任何条目）。
 */
export function affectedPathsInRepository(affectedPaths: readonly string[], repositoryRoot: string): boolean {
  return affectedPaths.some((affected) => affectedPathMatchesFile(repositoryRoot, affected));
}

/** diff 缓存条目（供选择器使用的通用形状）。 */
export interface GitDiffCacheEntry<T> {
  cwd: string;
  filePath: string;
  value: T;
}

/**
 * 定向失效选择器：给定缓存条目集合与受影响路径集合，返回应失效的条目。
 * 只选出受影响路径命中的条目，其余缓存保留——单文件修改只失效对应 diff。
 */
export function selectAffectedCacheEntries<T>(
  entries: readonly GitDiffCacheEntry<T>[],
  affectedPaths: readonly string[],
  repositoryRoot: string,
): GitDiffCacheEntry<T>[] {
  // 受影响路径不在仓库内时（含空集合）不失效任何条目。
  if (!affectedPathsInRepository(affectedPaths, repositoryRoot)) return [];
  return entries.filter((entry) => affectedPathsMatchFile(affectedPaths, entry.filePath));
}
