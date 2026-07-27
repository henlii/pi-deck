/**
 * Issue #3 D2：会话导出链接构建（纯函数，供单元测试）。
 *
 * 后端契约（并行后端提供，前端只按约定拼 URL）：
 *   GET /api/sessions/<encoded-id>/export
 *     - 默认：HTML，attachment 下载（不加 inline=1）
 *     - ?format=jsonl：当前分支 JSONL；leafId 为空时省略该参数
 *
 * 一律使用浏览器原生 <a href download>，不 fetch/blob，不把导出内容读进前端内存。
 */

/** 会话已持久化（有真实 id）才允许展示导出入口；新会话/未选择会话返回 false。 */
export function canExportSession(session: { id?: string | null } | null | undefined): boolean {
  return typeof session?.id === "string" && session.id.length > 0;
}

/** HTML 导出（完整会话，attachment）。 */
export function buildSessionExportHtmlHref(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/export`;
}

/** JSONL 导出（当前分支）；leafId 为空（null/undefined/""）时省略参数。 */
export function buildSessionExportJsonlHref(sessionId: string, leafId: string | null | undefined): string {
  const params = new URLSearchParams({ format: "jsonl" });
  if (leafId) params.set("leafId", leafId);
  return `${buildSessionExportHtmlHref(sessionId)}?${params.toString()}`;
}
