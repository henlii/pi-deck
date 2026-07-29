import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { sessionService } from "@/lib/session-service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (await sessionService.isReadOnly(id)) return NextResponse.json({ running: false, readOnly: true });
    // 只取 alive wrapper；无 live 绝不启动
    const rpc = sessionService.getLive(id);
    if (!rpc) return NextResponse.json({ running: false });

    const state = await rpc.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
