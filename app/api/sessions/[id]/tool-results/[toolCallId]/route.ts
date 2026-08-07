import { NextResponse } from "next/server";
import { getSessionEntries, resolveSessionPath } from "@/lib/session-reader";

/**
 * 懒加载历史 toolResult.details（首屏 deferMedia 会剥离 diff/patch 等大字段）。
 * GET /api/sessions/:id/tool-results/:toolCallId → { details }
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; toolCallId: string }> },
) {
  const { id, toolCallId } = await params;
  if (!toolCallId) {
    return NextResponse.json({ error: "toolCallId is required" }, { status: 400 });
  }

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });

    const entry = getSessionEntries(filePath).find((candidate) => {
      if (candidate.type !== "message") return false;
      const message = candidate.message as { role?: string; toolCallId?: string };
      return message.role === "toolResult" && message.toolCallId === toolCallId;
    });
    if (!entry || entry.type !== "message") {
      return NextResponse.json({ error: "Tool result not found" }, { status: 404 });
    }

    const message = entry.message as { details?: unknown };
    return NextResponse.json({ details: message.details ?? null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
