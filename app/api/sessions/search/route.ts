import { NextResponse } from "next/server";
import { searchSessionsFulltext } from "@/lib/session-fulltext-search";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { listArchiveRecords, realArchiveFs } from "@/lib/session-archive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/sessions/search?q=&limit=&scope=active|archived|all
 * 只读全文搜索：优先 hermes sessions.db FTS5，失败降级有界 JSONL 扫描。
 * scope 默认 active：索引可含全部真实会话，但结果在服务端按归档 sidecar
 * 分区过滤（active/archived 投影服务端完成，客户端不读 sidecar，D4）。
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    const scope = url.searchParams.get("scope") ?? "active";
    if (scope !== "active" && scope !== "archived" && scope !== "all") {
      return NextResponse.json({ error: `Invalid scope: ${scope}` }, { status: 400 });
    }
    const limitRaw = url.searchParams.get("limit");
    let maxHits: number | undefined;
    if (limitRaw !== null && limitRaw !== "") {
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || n < 1) {
        return NextResponse.json({ error: "limit must be a positive number" }, { status: 400 });
      }
      maxHits = Math.min(Math.floor(n), 100);
    }

    const result = await searchSessionsFulltext(q, {
      limits: maxHits !== undefined ? { maxHits } : undefined,
    });

    // 按 scope 过滤：归档记录集一次性读取（损坏/越权安全降级为空集）。
    let sessionIds = [...result.sessionIds];
    let hits = [...result.hits];
    if (scope !== "all") {
      const archivedIds = new Set(listArchiveRecords(realArchiveFs, getAgentDir()).map((r) => r.sessionId));
      if (scope === "active") {
        sessionIds = sessionIds.filter((id) => !archivedIds.has(id));
      } else {
        sessionIds = sessionIds.filter((id) => archivedIds.has(id));
      }
      const kept = new Set(sessionIds);
      hits = hits.filter((hit) => kept.has(hit.sessionId));
    }

    return NextResponse.json({
      query: result.query,
      source: result.source,
      hits,
      sessionIds,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
