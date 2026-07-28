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
  const cwd =
    cwdParam != null && cwdParam.trim() !== "" ? cwdParam : null;

  const body = listAgentRoster({ cwd, historyLimit });
  return NextResponse.json(body);
}
