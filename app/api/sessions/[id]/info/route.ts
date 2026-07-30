import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/[id]/info — 按 id 只读返回单条 SessionInfo。
 * 不启动 AgentSession；不存在 → 404。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  try {
    const session = await sessionService.getSessionInfo(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ session });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
