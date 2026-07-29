import { NextResponse } from "next/server";
import { buildSessionContext } from "@/lib/session-reader";
import { projectObservationalMemory } from "@/lib/om-ledger";
import { projectWorkspaceHistory } from "@/lib/workspace-history";
import { sessionService } from "@/lib/session-service";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");

  try {
    // 与主会话 GET 一致：getReadView 在存活 live wrapper 时用其 entries，避免 leaf 偏差。
    // readOnly subagent 仍可读；不 start。投影本身以请求 leafId 为准。
    const view = await sessionService.getReadView(id);
    if (!view) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = view.manager;
    const entries = sm.getEntries() as never;
    const context = buildSessionContext(entries, leafId, {
      deferThinking,
      deferToolResultImages,
    });
    const observationalMemory = projectObservationalMemory(entries, leafId ?? null);
    const workspaceHistory = projectWorkspaceHistory(entries, leafId ?? null);

    return NextResponse.json({ context, observationalMemory, workspaceHistory });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
