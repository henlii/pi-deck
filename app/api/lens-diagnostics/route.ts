/**
 * GET /api/lens-diagnostics?cwd=<required>
 * 只读 pi-lens 磁盘诊断缓存；忽略 root/path 等。
 * cwd 必须在 allow-list 内。绝不写盘、不启动 LSP。
 */

import { NextRequest, NextResponse } from "next/server";
import { normalize as normalizePath } from "node:path";
import { listLensDiagnostics } from "@/lib/lens-diagnostics";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";

export type {
  LensDiagnosticItem,
  LensDiagnosticsFileGroup,
  LensDiagnosticsSnapshot,
  LensQualityWarning,
  LensSeverity,
} from "@/lib/lens-diagnostics";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cwdParam = req.nextUrl.searchParams.get("cwd");
  if (cwdParam == null || cwdParam.trim() === "") {
    return NextResponse.json({ error: "cwd 必填" }, { status: 400 });
  }

  let cwd: string;
  try {
    cwd = normalizePath(cwdParam);
  } catch {
    return NextResponse.json({ error: "cwd 无效" }, { status: 400 });
  }

  try {
    const allowed = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowed)) {
      return NextResponse.json({ error: "cwd 不在允许范围内" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "无法校验 cwd 权限" }, { status: 500 });
  }

  try {
    const body = listLensDiagnostics({ cwd });
    return NextResponse.json(body);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
