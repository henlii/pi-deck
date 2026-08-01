/**
 * 会话列表的客户端 SWR 缓存（对齐 OpenChamber persist-cache.ts 语义）。
 *
 * 页面刷新后侧栏先用 localStorage 里的上次会话列表秒渲染（stale-while-
 * revalidate），后台 /api/sessions 刷新后覆盖；服务器不可达/出错时旧列表
 * 依然可见，不出现空白侧栏。只缓存列表元数据（SessionInfo 本身是精简
 * 投影），会话正文永远以服务器/磁盘为准；按 modified 取最近 N 条防止
 * localStorage 无限增长。
 */
import type { SessionInfo } from "./types";

const CACHE_KEY = "pidance.sessionList.v1";
const MAX_CACHED = 50;

/** 读缓存；无缓存/损坏/SSR 环境返回 null。 */
export function loadCachedSessionList(): SessionInfo[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sessions?: unknown };
    if (!Array.isArray(parsed.sessions)) return null;
    return parsed.sessions as SessionInfo[];
  } catch {
    return null;
  }
}

/** 写缓存（最近 MAX_CACHED 条；隐私模式等写入失败静默忽略）。 */
export function saveCachedSessionList(sessions: SessionInfo[]): void {
  if (typeof window === "undefined") return;
  try {
    const capped = [...sessions]
      .sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0))
      .slice(0, MAX_CACHED);
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ sessions: capped }));
  } catch {
    // ignore（隐私模式 / 配额）
  }
}
