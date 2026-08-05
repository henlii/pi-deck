import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";
import { ArchiveConflictError } from "@/lib/session-archive";
import { READ_ONLY_SUBAGENT_ERROR } from "@/lib/session-service";

/**
 * POST   /api/sessions/[id]/archive  → 归档（running 拒绝 409；readOnly 403）
 * DELETE /api/sessions/[id]/archive  → 恢复（返回恢复后的 SessionInfo）
 * Route Handler 只做参数校验与状态映射；逻辑全部在服务层。
 */
export const dynamic = "force-dynamic";

async function sessionIdOf(params: Promise<{ id: string }>): Promise<string> {
  const { id } = await params;
  return id;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = await sessionIdOf(params);
  try {
    const archivedAt = await sessionService.archiveSession(id);
    return NextResponse.json({ sessionId: id, archivedAt });
  } catch (error) {
    if (error instanceof ArchiveConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return NextResponse.json({ error: READ_ONLY_SUBAGENT_ERROR }, { status: 403 });
    }
    if (String(error).includes("Session not found")) {
      return NextResponse.json({ error: String(error) }, { status: 404 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = await sessionIdOf(params);
  try {
    const session = await sessionService.restoreSession(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ session });
  } catch (error) {
    if (String(error).includes("Session is not archived")) {
      return NextResponse.json({ error: String(error) }, { status: 404 });
    }
    if (String(error).includes("Session not found")) {
      return NextResponse.json({ error: String(error) }, { status: 404 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
