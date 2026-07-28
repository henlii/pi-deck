/**
 * GET /api/memory?cwd=<optional>
 * 只读 Hermes 记忆快照；忽略 root/path 等查询参数。
 * 绝不写盘。
 */

import { NextRequest, NextResponse } from "next/server";
import { readHermesMemory } from "@/lib/hermes-memory";

export type {
  HermesMemoryProject,
  HermesMemorySnapshot,
  MemoryEntry,
  MemorySection,
} from "@/lib/hermes-memory";

export async function GET(req: NextRequest) {
  // 只认 cwd；忽略 root/path 等
  const cwdParam = req.nextUrl.searchParams.get("cwd");
  const cwd =
    cwdParam != null && cwdParam.trim() !== "" ? cwdParam : null;

  const body = readHermesMemory({ cwd });
  return NextResponse.json(body);
}
