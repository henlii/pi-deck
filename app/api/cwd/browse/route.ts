import { NextResponse } from "next/server";
import { homedir } from "os";
import { browseDirectory, expandHome } from "@/lib/cwd-browse";

export const dynamic = "force-dynamic";

// GET /api/cwd/browse?path=/abs/or/~/path
// 添加项目弹窗的目录预览：子目录列表 + git 状态（只读，无写入）。
export async function GET(req: Request) {
	try {
		const url = new URL(req.url);
		// 缺省浏览家目录（对齐上游 0.8.1 cwd/browse 语义）
		const raw = url.searchParams.get("path")?.trim() || homedir();
		const abs = expandHome(raw);
		if (!abs) {
			return NextResponse.json({ error: "Invalid path" }, { status: 400 });
		}
		const result = await browseDirectory(raw);
		if (!result) {
			return NextResponse.json(
				{ error: `Directory does not exist: ${raw}` },
				{ status: 404 },
			);
		}
		return NextResponse.json(result);
	} catch {
		return NextResponse.json({ error: "Browse failed" }, { status: 500 });
	}
}
