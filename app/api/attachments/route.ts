import { NextRequest, NextResponse } from "next/server";
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
  ensureChatAttachmentsDir,
  saveChatAttachmentBytes,
  sanitizeAttachmentFileName,
} from "@/lib/chat-attachments";

export const dynamic = "force-dynamic";

/**
 * POST /api/attachments
 * multipart 字段 files：聊天非图片附件，落到 ~/.pi/agent/pidance-attachments/，
 * 不依赖项目 cwd。
 */
export async function POST(request: NextRequest) {
  try {
    // 预建目录并登记 allow-list
    ensureChatAttachmentsDir();

    const contentLength = Number(request.headers.get("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > CHAT_ATTACHMENT_MAX_TOTAL_BYTES + 5 * 1024 * 1024
    ) {
      return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
    }

    const formData = await request.formData();
    const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (files.length === 0) {
      return NextResponse.json({ error: "No files selected" }, { status: 400 });
    }
    if (files.some((file) => file.size > CHAT_ATTACHMENT_MAX_BYTES)) {
      return NextResponse.json({ error: "Each upload must be 25MB or smaller" }, { status: 413 });
    }
    if (files.reduce((sum, file) => sum + file.size, 0) > CHAT_ATTACHMENT_MAX_TOTAL_BYTES) {
      return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
    }

    const uploaded: Array<{ path: string; name: string; storedName: string; size: number }> = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const file of files) {
      const displayName = sanitizeAttachmentFileName(file.name || "file");
      try {
        const bytes = Buffer.from(await file.arrayBuffer());
        const saved = saveChatAttachmentBytes(displayName, bytes);
        uploaded.push(saved);
      } catch (error) {
        errors.push({
          name: displayName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return NextResponse.json(
      { uploaded, errors },
      { status: errors.length > 0 && uploaded.length === 0 ? 500 : errors.length > 0 ? 207 : 200 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
