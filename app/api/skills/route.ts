import { NextResponse } from "next/server";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { SkillWriteError, toggleSkillDisableModelInvocation } from "@/lib/skills-write";

export const dynamic = "force-dynamic";

// GET /api/skills?cwd=<path>
// Uses DefaultResourceLoader (same logic as AgentSession startup) so settings.json
// skill paths, package skills, and .agents/skills directories are all included.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    return NextResponse.json(await loadSkillsWithInstallInfo(cwd));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a loader-authorized SKILL.md
export async function PATCH(req: Request) {
  try {
    const body = await req.json() as {
      cwd?: string;
      filePath?: string;
      disableModelInvocation?: boolean;
    };
    return NextResponse.json(await toggleSkillDisableModelInvocation({
      cwd: body.cwd ?? "",
      filePath: body.filePath ?? "",
      disableModelInvocation: body.disableModelInvocation ?? false,
    }));
  } catch (e) {
    if (e instanceof SkillWriteError) {
      const status = e.code === "forbidden" ? 403 : e.code === "not-found" ? 404 : 400;
      return NextResponse.json({ error: e.message }, { status });
    }
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
