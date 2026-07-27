import { NextResponse } from "next/server";
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  readSessionHeader,
  listAllSessions,
  resolveSessionManagerForRead,
  buildSessionNavigationSnapshot,
} from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { sessionService, READ_ONLY_SUBAGENT_ERROR, requireWritableSession } from "@/lib/session-service";
import { collectSubagentTree, deleteValidatedSubagents } from "@/lib/subagent-sessions";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // navigateTree 只改 live sessionManager leaf，不改磁盘末 entry；
    // 有存活 wrapper 时以 live 为权威，避免 loadSession 整刷跳回旧 leaf。
    const sm = resolveSessionManagerForRead({
      filePath,
      liveSession: getRpcSession(id) ?? null,
    });
    const searchParams = new URL(req.url).searchParams;
    const { leafId, tree, context, header, sessionName, observationalMemory, workspaceHistory } = buildSessionNavigationSnapshot(sm, {
      deferThinking: searchParams.has("deferThinking"),
      deferToolResultImages: searchParams.has("deferMedia"),
    });

    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const relation = (await listAllSessions()).find((session) => session.id === id);
    const info = header ? {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sessionName,
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      ...(relation?.subagent ? { subagent: relation.subagent, readOnly: true as const } : {}),
    } : null;

    return NextResponse.json({
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      context,
      observationalMemory,
      workspaceHistory,
    });
  } catch (error) {
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return NextResponse.json({ error: READ_ONLY_SUBAGENT_ERROR }, { status: 403 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await requireWritableSession(id, sessionService.isReadOnly);
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const sm = SessionManager.open(filePath);
    sm.appendSessionInfo(name.trim());
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return NextResponse.json({ error: READ_ONLY_SUBAGENT_ERROR }, { status: 403 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await requireWritableSession(id, sessionService.isReadOnly);
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Read only the bounded header before deleting.
    const parentSessionPath = readSessionHeader(filePath)?.parentSession;

    const verifiedChildren = readSessionHeader(filePath)?.id === id
      ? collectSubagentTree(filePath, id)
      : [];

    // Re-attach all direct children to this session's parent (cascade re-parent)
    // Scan sibling files in the same directory
    const dir = filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && join(dir, f) !== filePath);
      for (const file of files) {
        const childPath = join(dir, file);
        try {
          const content = readFileSync(childPath, "utf8");
          const lines = content.split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
          if (header.type === "session" && header.parentSession === filePath) {
            // Rewrite header with new parentSession
            header.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(header);
            writeFileSync(childPath, lines.join("\n"));
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip if dir unreadable */ }

    getRpcSession(id)?.destroy();
    unlinkSync(filePath);
    const parentRoot = resolve(filePath.slice(0, -6));
    const skippedSubagents = deleteValidatedSubagents(verifiedChildren, parentRoot, invalidateSessionPathCache);
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true, skippedSubagents });
  } catch (error) {
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return NextResponse.json({ error: READ_ONLY_SUBAGENT_ERROR }, { status: 403 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
