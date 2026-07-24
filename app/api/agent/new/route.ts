import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";

// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns { sessionId, data } where sessionId is pi's real session id.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;

    const { sessionId, data } = await sessionService.createNew({
      cwd: cwd as string,
      command: command as { type: string; [key: string]: unknown },
    });

    return NextResponse.json({ success: true, sessionId, data });
  } catch (error) {
    const message = String(error);
    if (message === "cwd is required") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (message.startsWith("Directory does not exist:")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
