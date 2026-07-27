import { NextResponse } from "next/server";
import {
  applyProjectTrustChoice,
  getProjectTrustParent,
  getProjectTrustStatus,
  isAllowedProjectCwd,
  isUsableProjectPath,
  listProjectTrustDecisions,
} from "@/lib/project-trust";
import { isProjectTrustChoice } from "@/lib/project-trust-model";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/project-trust                 → trust.json 全部决策 + defaultProjectTrust（只读）
 * GET /api/project-trust?cwd=A&cwd=B ...  → 这些目录的信任状态（只读，一次问完侧栏所有项目）
 *
 * 无 cwd 的列表端点保持开放（只读展示 trust.json，不暴露任意路径探测）。
 * 带 cwd 时：先确认是存在目录，再要求 canonical cwd 在允许根内；拒绝 403。
 * 无法解析的 cwd（已删除、不是目录）不让整个请求失败：它在 statuses 中缺席，
 * 侧栏据此不显示徽章，与「项目已消失」的观感一致。
 */
export async function GET(req: Request) {
  try {
    const cwds = new URL(req.url).searchParams.getAll("cwd").filter((value) => value !== "");
    if (cwds.length === 0) {
      return NextResponse.json(listProjectTrustDecisions());
    }
    const statuses = [];
    for (const cwd of new Set(cwds)) {
      if (!isUsableProjectPath(cwd)) continue;
      if (!(await isAllowedProjectCwd(cwd))) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      statuses.push({ cwd, status: getProjectTrustStatus(cwd), parentPath: getProjectTrustParent(cwd) });
    }
    return NextResponse.json({ statuses });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/**
 * POST /api/project-trust { cwd, choice: "trust" | "trust-parent" | "distrust" }
 * 通过 SDK ProjectTrustStore 持久化到 ~/.pi/agent/trust.json（Pi 原生格式，带文件锁）。
 * 只写 trust.json，不碰 settings.json / auth.json / models.json / sessions。
 * 顺序：存在目录 → 允许根 → choice 校验 → 写入。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { cwd?: unknown; choice?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    if (!isUsableProjectPath(cwd)) {
      return NextResponse.json({ error: "cwd must be an existing directory" }, { status: 400 });
    }
    if (!(await isAllowedProjectCwd(cwd))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (!isProjectTrustChoice(body.choice)) {
      return NextResponse.json(
        { error: "choice must be one of trust | trust-parent | distrust" },
        { status: 400 },
      );
    }
    const parentPath = getProjectTrustParent(cwd);
    if (body.choice === "trust-parent" && !parentPath) {
      return NextResponse.json({ error: "no parent folder to trust" }, { status: 400 });
    }
    return NextResponse.json({
      cwd,
      status: applyProjectTrustChoice(cwd, body.choice),
      parentPath,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
