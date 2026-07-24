import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";

export async function GET() {
  try {
    const { sessions, runningSessionIds } = await sessionService.listSessions();
    return NextResponse.json({ sessions, runningSessionIds });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
