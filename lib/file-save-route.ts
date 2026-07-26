import { NextResponse } from "next/server";
import {
  getAllowedFileRoots,
  isFilePathAllowed,
  isWindowsAbsolutePath,
  normalizeSlashes,
} from "./file-access";
import { getAudioMime, getDocumentMime, getImageMime } from "./file-types";
import { FileSaveError, saveFile, type SaveFileOptions } from "./file-save";
import { readSessionHeader, resolveSessionPath } from "./session-reader";
import { ReadOnlySubagentError, requireWritableSession, sessionService } from "./session-service";

type SaveRequest = {
  json(): Promise<unknown>;
  nextUrl: { searchParams: URLSearchParams };
};

export type SaveRouteDeps = {
  resolveSessionPath: typeof resolveSessionPath;
  requireWritableSession: typeof requireWritableSession;
  isReadOnly: typeof sessionService.isReadOnly;
  readSessionHeader: typeof readSessionHeader;
  getAllowedFileRoots: typeof getAllowedFileRoots;
  saveFile: typeof saveFile;
  isFilePathAllowed: typeof isFilePathAllowed;
  getBinaryMime: (filePath: string) => string | null;
};

const defaultDeps: SaveRouteDeps = {
  resolveSessionPath,
  requireWritableSession,
  isReadOnly: sessionService.isReadOnly,
  readSessionHeader,
  getAllowedFileRoots,
  saveFile,
  isFilePathAllowed,
  getBinaryMime: (filePath) => getImageMime(filePath) || getAudioMime(filePath) || getDocumentMime(filePath),
};

function errorResponse(error: unknown): Response {
  if (error instanceof FileSaveError) {
    const status = { "bad-request": 400, forbidden: 403, "not-found": 404, conflict: 409, "too-large": 413 }[error.code];
    if (error.code === "conflict") {
      return NextResponse.json({ error: "File changed externally", baseline: JSON.parse(error.message) }, { status });
    }
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

export async function handleSaveRequest(
  request: SaveRequest,
  target: string,
  deps: Partial<SaveRouteDeps> = {},
): Promise<Response> {
  const actual = { ...defaultDeps, ...deps };
  try {
    const rawTarget = normalizeSlashes(target);
    if (!rawTarget.startsWith("/") && !isWindowsAbsolutePath(rawTarget)) return NextResponse.json({ error: "Save target must be absolute" }, { status: 400 });
    const sessionId = request.nextUrl.searchParams.get("sessionId");
    if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    const body = await request.json().catch(() => null) as { content?: unknown; baseline?: { mtimeMs?: unknown; size?: unknown } } | null;
    if (typeof body?.content !== "string" || typeof body.baseline?.mtimeMs !== "number" || !Number.isFinite(body.baseline.mtimeMs) || body.baseline.mtimeMs < 0 || typeof body.baseline?.size !== "number" || !Number.isFinite(body.baseline.size) || body.baseline.size < 0) {
      return NextResponse.json({ error: "Invalid save request" }, { status: 400 });
    }
    const sessionPath = await actual.resolveSessionPath(sessionId);
    if (!sessionPath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    try {
      await actual.requireWritableSession(sessionId, actual.isReadOnly);
    } catch (error) {
      if (error instanceof ReadOnlySubagentError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
    const header = actual.readSessionHeader(sessionPath);
    if (!header?.cwd) return NextResponse.json({ error: "Session cwd not found" }, { status: 404 });
    const options: SaveFileOptions = {
      target,
      cwd: header.cwd,
      sourceSessionId: sessionId,
      allowedRoots: await actual.getAllowedFileRoots(),
      content: body.content,
      baseline: { mtimeMs: body.baseline.mtimeMs, size: body.baseline.size },
      isAllowed: actual.isFilePathAllowed,
      getBinaryMime: actual.getBinaryMime,
    };
    const result = actual.saveFile(options);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
