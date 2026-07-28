/**
 * GET /api/agents?cwd=<optional>&historyLimit=<optional>
 * 只读 subagent 花名册 + run-history 尾部；忽略 root/path 等查询参数。
 * 绝不写盘。
 */

import { NextRequest, NextResponse } from "next/server";
import {
  listAgentRoster,
  parseHistoryLimit,
} from "@/lib/agent-roster";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { normalize as normalizePath } from "node:path";

export type {
  AgentRosterEntry,
  AgentRosterSnapshot,
  AgentSource,
  RunHistoryEntry,
} from "@/lib/agent-roster";

export async function GET(req: NextRequest) {
  const historyLimit = parseHistoryLimit(req.nextUrl.searchParams.get("historyLimit"));
  if (historyLimit === null) {
    return NextResponse.json(
      { error: "historyLimit 必须为 1–100 的整数" },
      { status: 400 },
    );
  }

  // 只认 cwd；忽略 root/path 等
  const cwdParam = req.nextUrl.searchParams.get("cwd");
  let cwd: string | null = null;
  if (cwdParam != null && cwdParam.trim() !== "") {
    // 受控：只接受 allow-list 内的项目目录，越权 cwd 一律降级为 null（只看 builtin/user/package）
    try {
      const resolved = normalizePath(cwdParam);
      const allowed = await getAllowedFileRoots();
      if (isFilePathAllowed(resolved, allowed)) {
        cwd = resolved;
      }
    } catch {
      cwd = null;
    }
  }

  const body = listAgentRoster({ cwd, historyLimit });
  return NextResponse.json(body);
}
