#!/usr/bin/env node
/**
 * 发布包审计 CLI。
 *
 * 生成前（默认 / pre）：
 *   node scripts/audit-release-package.mjs
 *   node scripts/audit-release-package.mjs --pre
 *   npm run release:audit
 *   → npm pack --dry-run --json --ignore-scripts，完整扫描可扫描文本（超限/缺失 fail closed）
 *
 * 生成后（真实 tgz）：
 *   node scripts/audit-release-package.mjs --tgz <path.tgz>
 *   npm run release:audit:tgz -- path.tgz
 *   → 直接解析 tgz 内容审计；bin 只信包内 package.json，不读工作区冒充制品
 *
 * 不生成 tgz（pre）、不 publish、不 version/tag/push。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditReleasePackage,
  auditReleaseTgz,
  formatAuditReport,
  loadWorkspaceTextContents,
  normalizePackDryRun,
} from "../lib/release-package-audit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function printUsage() {
  console.error(`用法:
  node scripts/audit-release-package.mjs [--pre]
  node scripts/audit-release-package.mjs --tgz <path.tgz>
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    return { mode: "help" };
  }
  const tgzIdx = args.findIndex((a) => a === "--tgz" || a === "--post");
  if (tgzIdx >= 0) {
    const tgzPath = args[tgzIdx + 1];
    if (!tgzPath || tgzPath.startsWith("-")) {
      return { mode: "error", message: "--tgz 需要 tgz 路径" };
    }
    return { mode: "tgz", tgzPath: path.resolve(process.cwd(), tgzPath) };
  }
  // 兼容：npm run release:audit:tgz -- file.tgz 可能只传位置参数
  if (args[0] && !args[0].startsWith("-") && args[0].endsWith(".tgz")) {
    return { mode: "tgz", tgzPath: path.resolve(process.cwd(), args[0]) };
  }
  return { mode: "pre" };
}

function loadPackageJson() {
  const raw = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
  return JSON.parse(raw);
}

function runNpmPackDryRun() {
  const result = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: process.env,
    },
  );
  if (result.error) {
    console.error(`无法执行 npm pack: ${result.error.message}`);
    process.exit(2);
  }
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || `npm pack 退出码 ${result.status}`);
    process.exit(result.status ?? 1);
  }
  const stdout = (result.stdout || "").trim();
  if (!stdout) {
    console.error("npm pack --dry-run --json 无输出");
    process.exit(2);
  }
  try {
    return JSON.parse(stdout);
  } catch (err) {
    console.error(`解析 npm pack JSON 失败: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
}

function emitResult(result) {
  const report = formatAuditReport(result);
  if (result.ok) {
    console.log(report);
    process.exit(0);
  }
  console.error(report);
  process.exit(1);
}

function runPre() {
  const pkg = loadPackageJson();
  const packJson = runNpmPackDryRun();
  const pack = normalizePackDryRun(packJson);
  const fileContents = loadWorkspaceTextContents(
    repoRoot,
    pack.files.map((f) => f.path),
  );
  const result = auditReleasePackage({
    pack,
    bin: pkg.bin ?? null,
    repoRoot,
    homeDir: os.homedir(),
    fileContents,
    requireTextContents: true,
  });
  emitResult(result);
}

function runTgz(tgzPath) {
  if (!fs.existsSync(tgzPath)) {
    console.error(`tgz 不存在: ${tgzPath}`);
    process.exit(2);
  }
  // 期望身份来自当前 checkout 的 package.json（干净 tag）；bin/内容仍只信 tgz
  const pkg = loadPackageJson();
  const result = auditReleaseTgz({
    tgzPathOrBuffer: tgzPath,
    filename: path.basename(tgzPath),
    repoRoot,
    homeDir: os.homedir(),
    expectedName: typeof pkg.name === "string" ? pkg.name : null,
    expectedVersion: typeof pkg.version === "string" ? pkg.version : null,
  });
  emitResult(result);
}

function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.mode === "help") {
    printUsage();
    process.exit(0);
  }
  if (parsed.mode === "error") {
    console.error(parsed.message);
    printUsage();
    process.exit(2);
  }
  if (parsed.mode === "tgz") {
    runTgz(parsed.tgzPath);
    return;
  }
  runPre();
}

main();
