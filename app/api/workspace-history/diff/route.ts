import { NextResponse } from "next/server";
import {
  isSafeCommitRef,
  listWorkspaceSnapshotDiff,
  resolveWorkspaceHistoryStoragePaths,
} from "@/lib/workspace-history";

/**
 * GET /api/workspace-history/diff?cwd=&sessionId=&from=&to=
 * 只读 name-status diff；不写 shadow。
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cwd = url.searchParams.get("cwd")?.trim() ?? "";
    const sessionId = url.searchParams.get("sessionId")?.trim() ?? "";
    const from = url.searchParams.get("from")?.trim() ?? "";
    const to = url.searchParams.get("to")?.trim() ?? "";

    if (!cwd || !sessionId || !from || !to) {
      return NextResponse.json(
        { error: "cwd, sessionId, from, to are required" },
        { status: 400 },
      );
    }
    if (!isSafeCommitRef(from) || !isSafeCommitRef(to)) {
      return NextResponse.json({ error: "invalid commit ref" }, { status: 400 });
    }

    const paths = resolveWorkspaceHistoryStoragePaths({ cwd, sessionId });
    const result = await listWorkspaceSnapshotDiff({
      shadowGitDir: paths.shadowGitDir,
      fromCommit: from,
      toCommit: to,
      storageDir: paths.storageDir,
    });

    return NextResponse.json({
      files: result.files,
      ...(result.error ? { error: result.error } : {}),
      workspaceHash: paths.workspaceHash,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
