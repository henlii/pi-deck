// 归档功能客户端封装与纯逻辑（UI 层消费）。
//
// 服务端 lib/session-archive.ts / app/api/sessions/[id]/archive/route.ts 为权威，
// 本模块只做：fetch 动作封装（可注入便于测试）、归档列表排序、行标题投影、
// 失败分类映射。不改 Pi schema、不写 sidecar。

import type { SessionInfo } from "./types";

export interface ArchiveActionResult {
  ok: boolean;
  /** HTTP 状态码；网络/解析失败为 0。 */
  status: number;
  /** 服务端返回的 error 文案（可能为空）。 */
  error?: string;
}

async function requestJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<ArchiveActionResult> {
  try {
    const res = await fetchImpl(url, init);
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: res.ok, status: res.status, error: body.error };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 归档会话：POST /api/sessions/[id]/archive（running → 409，readOnly → 403）。 */
export function archiveSession(
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ArchiveActionResult> {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "POST" }, fetchImpl);
}

/** 恢复归档会话：DELETE /api/sessions/[id]/archive（返回恢复后的 SessionInfo）。 */
export function restoreSession(
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ArchiveActionResult> {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "DELETE" }, fetchImpl);
}

/** 永久删除会话：DELETE /api/sessions/[id]（后端自动清理归档 sidecar）。 */
export function deleteSessionPermanently(
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ArchiveActionResult> {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }, fetchImpl);
}

// ---------------------------------------------------------------------------
// 纯逻辑
// ---------------------------------------------------------------------------

function archivedTs(session: SessionInfo): number {
  if (!session.archivedAt) return Number.NEGATIVE_INFINITY;
  const ts = Date.parse(session.archivedAt);
  return Number.isNaN(ts) ? Number.NEGATIVE_INFINITY : ts;
}

/** 归档列表按 archivedAt 降序（最新在前）；缺 archivedAt / 非法日期排最后且保持原顺序。 */
export function sortArchivedSessions(sessions: readonly SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    const ta = archivedTs(a);
    const tb = archivedTs(b);
    if (ta === tb) return 0;
    if (ta === Number.NEGATIVE_INFINITY) return 1;
    if (tb === Number.NEGATIVE_INFINITY) return -1;
    return tb - ta;
  });
}

/** 行标题投影：name → 首消息（截断）→ id，与侧栏会话行语义一致。 */
export function archiveRowTitle(session: SessionInfo, maxLength = 60): string {
  const raw = session.name?.trim() || session.firstMessage.trim() || session.id;
  return raw.length <= maxLength ? raw : `${raw.slice(0, maxLength)}…`;
}

/** 删除确认状态机：同一会话再次点击取消；点击其它会话切换目标。 */
export function toggleDeleteConfirm(
  current: { sessionId: string | null },
  sessionId: string,
): { sessionId: string | null } {
  return current.sessionId === sessionId ? { sessionId: null } : { sessionId };
}

// ---------------------------------------------------------------------------
// 失败分类（UI 据分类取 i18n 文案，不硬编码服务端消息）
// ---------------------------------------------------------------------------

export type ArchiveFailureKind = "running" | "readOnly" | "network" | "other";

export function archiveFailureKind(result: ArchiveActionResult): ArchiveFailureKind {
  if (result.ok) return "other";
  if (result.status === 409) return "running";
  if (result.status === 403) return "readOnly";
  if (result.status === 0) return "network";
  return "other";
}
