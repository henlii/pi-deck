import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "@/lib/session-title";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { sessionService, READ_ONLY_SUBAGENT_ERROR } from "@/lib/session-service";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // ensureLive：readOnly 门禁 + 复用/启动；不存在 → Session not found
    const session = await sessionService.ensureLive(id);

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner as unknown as AgentSession);

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return NextResponse.json({ error: READ_ONLY_SUBAGENT_ERROR }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Session not found")) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
