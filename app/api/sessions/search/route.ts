import { NextResponse } from "next/server";
import { searchSessionsFulltext } from "@/lib/session-fulltext-search";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/sessions/search?q=&limit=
 * 只读全文搜索：优先 hermes sessions.db FTS5，失败降级有界 JSONL 扫描。
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
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

    return NextResponse.json({
      query: result.query,
      source: result.source,
      hits: result.hits,
      sessionIds: result.sessionIds,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
