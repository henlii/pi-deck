/**
 * 新会话引导页（NewSessionGuide）的纯逻辑缓存：
 * - 项目列表聚合（/api/sessions → 最近 cwd 列表）与持久化目标项目解析
 * - 工作树列表按 cwd 的 in-flight 去重 + stale-while-revalidate 语义
 *
 * 抽为纯模块以便 node:test 覆盖；组件只负责 UI 状态映射。
 */

export interface GuideWorktreeInfo {
  path: string;
  branch?: string;
  isMain?: boolean;
}

export interface GuideProject {
  cwd: string;
  count: number;
  latest: number;
}

/** 聚合会话列表（含 cwd/created/modified）为「最近项目」列表，按最新活动降序取前 limit。 */
export function aggregateGuideProjects(
  sessions: ReadonlyArray<{ cwd?: string; created?: string; modified?: string }>,
  limit = 12,
): GuideProject[] {
  const byCwd = new Map<string, { count: number; latest: number }>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const ts = s.modified
      ? Date.parse(s.modified)
      : s.created
        ? Date.parse(s.created)
        : 0;
    const entry = byCwd.get(s.cwd) ?? { count: 0, latest: 0 };
    entry.count += 1;
    if (ts > entry.latest) entry.latest = ts;
    byCwd.set(s.cwd, entry);
  }
  return [...byCwd.entries()]
    .map(([cwd, v]) => ({ cwd, count: v.count, latest: v.latest }))
    .sort((a, b) => b.latest - a.latest)
    .slice(0, limit);
}

/** 解析持久化目标 cwd 归属的项目：先精确匹配项目根，再最长前缀匹配（工作树路径）。无匹配返回 null。 */
export function resolveGuideTargetProject(
  projects: ReadonlyArray<{ cwd: string }>,
  targetCwd: string,
): string | null {
  if (projects.some((p) => p.cwd === targetCwd)) return targetCwd;
  const parent = projects
    .filter((p) => targetCwd.startsWith(p.cwd + "/"))
    .sort((a, b) => b.cwd.length - a.cwd.length)[0];
  return parent ? parent.cwd : null;
}

export interface WorktreeCacheState {
  /** cwd → 最近一次成功加载的列表（stale 数据，用于 SWR 立即渲染） */
  data: Map<string, GuideWorktreeInfo[]>;
  /** cwd → in-flight 请求（并发去重） */
  inFlight: Map<string, Promise<GuideWorktreeInfo[]>>;
}

export function createWorktreeCache(): WorktreeCacheState {
  return { data: new Map(), inFlight: new Map() };
}

export interface WorktreeLoadHandle {
  /** 该 cwd 的最终结果（复用 in-flight 或新发起的请求） */
  promise: Promise<GuideWorktreeInfo[]>;
  /** 已有缓存（stale）；无缓存为 null —— 调用方据此决定显示旧数据还是 loading */
  stale: GuideWorktreeInfo[] | null;
}

/**
 * 发起（或复用）某 cwd 的工作树加载，SWR 语义：
 * - 同 cwd 的并发调用共享同一个 in-flight Promise（去重，不重复请求）
 * - 已加载过的 cwd 立即返回旧列表（stale），后台刷新完成后经 promise 覆盖
 * - 加载失败不写入缓存：保留旧数据，下次调用可重试
 */
export function beginWorktreeLoad(
  cache: WorktreeCacheState,
  cwd: string,
  loader: () => Promise<GuideWorktreeInfo[]>,
): WorktreeLoadHandle {
  const stale = cache.data.get(cwd) ?? null;
  const existing = cache.inFlight.get(cwd);
  if (existing) return { promise: existing, stale };

  const promise = Promise.resolve()
    .then(loader)
    .then((wts) => {
      cache.data.set(cwd, wts);
      return wts;
    })
    .finally(() => {
      if (cache.inFlight.get(cwd) === promise) cache.inFlight.delete(cwd);
    });
  cache.inFlight.set(cwd, promise);
  return { promise, stale };
}

/** 新建工作树成功后使该 cwd 的缓存失效，下次加载强制重新请求。 */
export function clearWorktreeCache(cache: WorktreeCacheState, cwd: string): void {
  cache.data.delete(cwd);
  cache.inFlight.delete(cwd);
}
