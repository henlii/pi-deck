/**
 * GET /api/subagent-runs?limit=20
 * 只读列出当前用户 pi-subagents 异步 run；不接受 root/path/runId。
 * 对已发现的只读 SessionInfo.path 匹配 step.sessionFile 后附加 sessionId。
 */

import { NextRequest, NextResponse } from "next/server";
import {
  attachDiscoveredSessionIds,
  listSubagentRuns,
  parseSubagentRunsLimit,
} from "@/lib/subagent-runs";
import { sessionService } from "@/lib/session-service";

export type {
  SubagentActivityState,
  SubagentRunEventView,
  SubagentRunMode,
  SubagentRunState,
  SubagentRunStepView,
  SubagentRunView,
  SubagentRunsResponse,
  SubagentTokenUsage,
} from "@/lib/subagent-run-types";

export async function GET(req: NextRequest) {
  const limit = parseSubagentRunsLimit(req.nextUrl.searchParams.get("limit"));
  if (limit === null) {
    return NextResponse.json(
      { error: "limit 必须为 1–50 的整数" },
      { status: 400 },
    );
  }

  // 忽略任何 root/path/runId 查询参数，根固定由当前用户 scope 推导
  const body = listSubagentRuns({ limit });

  // 会话列表失败时仍返回 run 数据，仅不附加 sessionId（避免假 affordance 与整 API 失败）
  try {
    const { sessions } = await sessionService.listSessions();
    const projected = attachDiscoveredSessionIds(body, sessions);
    return NextResponse.json(projected);
  } catch {
    return NextResponse.json(body);
  }
}
