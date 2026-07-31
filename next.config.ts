import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const nextConfig: NextConfig = {
  // 公网生产构建可设 PIDANCE_DIST_DIR=.next-public，避免污染 dev 的 .next
  distDir: process.env.PIDANCE_DIST_DIR || ".next",
  serverExternalPackages: [
    "undici",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ],
  webpack(config, { isServer }) {
    if (isServer) {
      // instrumentation.ts 也必须复用 Node 侧的 undici；否则 webpack 会尝试
      // 打包其 node:console 等内建模块并触发 UnhandledSchemeError。
      config.externals.push({ undici: "commonjs undici" });
    }
    return config;
  },
  ...(process.env.NODE_ENV === "development"
    ? { allowedDevOrigins: ["127.0.0.1", "192.168.*.*", "100.99.31.21", "pidance.namixinxi.cn"] }
    : {}),
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
