import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { buildAboutInfo } from "@/lib/about-info";

export async function GET() {
  try {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const pkg: unknown = JSON.parse(raw);
    return NextResponse.json(buildAboutInfo(pkg));
  } catch {
    return NextResponse.json(
      buildAboutInfo({
        name: "@henlii/pi-deck",
        version: "0.0.0",
        dependencies: { "@earendil-works/pi-coding-agent": "0.81.1" },
        homepage: "https://github.com/henlii/pi-deck#readme",
        repository: { type: "git", url: "git+https://github.com/henlii/pi-deck.git" },
      }),
    );
  }
}
