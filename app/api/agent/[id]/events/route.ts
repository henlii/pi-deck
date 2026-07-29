import { sessionService, READ_ONLY_SUBAGENT_ERROR, requireWritableSession } from "@/lib/session-service";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // 门禁错误形态与历史一致：readOnly→403 JSON，门禁内部异常→500 JSON（非 Failed to start 文本）
  try {
    await requireWritableSession(id, sessionService.isReadOnly);
  } catch (error) {
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return new Response(JSON.stringify({ error: READ_ONLY_SUBAGENT_ERROR }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  // ensureLive：复用 alive 或 resolve/start；Route 不再直接 import rpc-manager
  let session;
  try {
    session = await sessionService.ensureLive(id);
  } catch (error) {
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return new Response(JSON.stringify({ error: READ_ONLY_SUBAGENT_ERROR }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Session not found")) {
      return new Response("Session not found", { status: 404 });
    }
    return new Response(`Failed to start agent: ${error}`, { status: 500 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(new TextEncoder().encode(text));
      };

      // Send initial connected event
      encode({ type: "connected", sessionId: id });

      const unsubscribe = session.onEvent((event) => {
        encode(event);
      });

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      // Cleanup when client disconnects
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        controller.close();
      };

      // Detect client disconnect via abort signal
      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
