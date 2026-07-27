import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { buildAboutInfo } from "@/lib/about-info";

/** 优先读已安装 pi-coding-agent 的真实 version，再回退 package.json 依赖声明。 */
function readInstalledPiSdkVersion(): string | null {
  try {
    const raw = readFileSync(
      join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/package.json"),
      "utf8",
    );
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const pkg: unknown = JSON.parse(raw);
    const info = buildAboutInfo(pkg);
    const installed = readInstalledPiSdkVersion();
    if (installed) info.piSdkVersion = installed;
    return NextResponse.json(info);
  } catch {
    const fallback = buildAboutInfo({
      name: "@henlii/pi-deck",
      version: process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0",
      dependencies: {
        "@earendil-works/pi-coding-agent": process.env.NEXT_PUBLIC_PI_VERSION || "0.81.1",
      },
      homepage: "https://github.com/henlii/pi-deck#readme",
      repository: { type: "git", url: "git+https://github.com/henlii/pi-deck.git" },
    });
    const installed = readInstalledPiSdkVersion();
    if (installed) fallback.piSdkVersion = installed;
    return NextResponse.json(fallback);
  }
}
