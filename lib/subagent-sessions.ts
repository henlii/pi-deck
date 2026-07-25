import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync, rmdirSync, unlinkSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import type { SessionHeader } from "./types";

export type DiscoveredSubagent = {
  path: string;
  header: SessionHeader;
  runIndex: number;
  parentSessionId: string;
  runId: string;
  agent?: string;
};

const MAX_CHILDREN = 256;
const MAX_DEPTH = 16;
const MAX_SCAN_ENTRIES = 2048;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_LINE_BYTES = 128 * 1024;
const MAX_METADATA_CANDIDATES = 512;
const HEX_RUN = /^[0-9a-f]{8}$/i;
const RUN_DIR = /^run-(\d+)$/;

export const SUBAGENT_DISCOVERY_LIMITS = {
  maxChildren: MAX_CHILDREN,
  maxDepth: MAX_DEPTH,
  maxScanEntries: MAX_SCAN_ENTRIES,
  maxMetadataBytes: MAX_METADATA_BYTES,
  maxMetadataLineBytes: MAX_METADATA_LINE_BYTES,
  maxMetadataCandidates: MAX_METADATA_CANDIDATES,
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRealFile(file: string, root: string): string | null {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || !file.endsWith(".jsonl")) return null;
    const real = realpathSync(file);
    const realRoot = realpathSync(root);
    const rel = relative(realRoot, real);
    if (!rel || rel.startsWith("..") || rel.includes("/../") || rel.includes("\\..\\")) return null;
    // 逐级检查，避免 realpath 把中间 symlink 隐藏后仍被当作候选。
    let current = realRoot;
    for (const part of rel.split(/[\\/]/)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return null;
    }
    return real;
  } catch { return null; }
}

function readHeader(file: string): SessionHeader | null {
  let fd = -1;
  try {
    fd = openSync(file, "r");
    const chunks: Buffer[] = [];
    let total = 0;
    let found = false;
    while (total < 65536 && !found) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, 65536 - total));
      const count = readSync(fd, buffer, 0, buffer.length, total);
      if (!count) break;
      const part = buffer.subarray(0, count);
      const newline = part.indexOf(0x0a);
      chunks.push(newline >= 0 ? part.subarray(0, newline) : part);
      total += count;
      found = newline >= 0;
    }
    if (!found && total >= 65536) return null;
    const line = Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
    const value = JSON.parse(line) as unknown;
    if (!record(value) || value.type !== "session" || typeof value.id !== "string" || !value.id ||
      typeof value.cwd !== "string" || typeof value.timestamp !== "string") return null;
    return value as unknown as SessionHeader;
  } catch { return null; }
  finally { if (fd >= 0) closeSync(fd); }
}

function runIndex(file: string): number | null {
  const match = RUN_DIR.exec(basename(dirname(file)));
  return match ? Number(match[1]) : null;
}

function isStrictLayout(file: string, root: string): boolean {
  const parts = relative(resolve(root), resolve(file)).split(/[\\/]/);
  return parts.length === 3 && HEX_RUN.test(parts[0]) && RUN_DIR.test(parts[1]) && parts[2] === "session.jsonl";
}

type MetadataCandidate = { path: string; runId?: string; agent?: string };

function metadataPaths(parentFile: string): MetadataCandidate[] {
  const candidates: MetadataCandidate[] = [];
  let fd = -1;
  try {
    fd = openSync(parentFile, "r");
    let carry = "";
    let total = 0;
    while (total < MAX_METADATA_BYTES && candidates.length < MAX_METADATA_CANDIDATES) {
      const buffer = Buffer.allocUnsafe(Math.min(65536, MAX_METADATA_BYTES - total));
      const count = readSync(fd, buffer, 0, buffer.length, total);
      if (!count) break;
      total += count;
      carry += buffer.subarray(0, count).toString("utf8");
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > MAX_METADATA_LINE_BYTES) continue;
        parseMetadataLine(line, candidates);
        if (candidates.length >= MAX_METADATA_CANDIDATES) break;
      }
    }
    if (carry.length <= MAX_METADATA_LINE_BYTES && candidates.length < MAX_METADATA_CANDIDATES) parseMetadataLine(carry, candidates);
  } catch { /* 损坏的父文件不会阻断其它会话 */ }
  finally { if (fd >= 0) closeSync(fd); }
  return candidates;
}

export function validateSubagentFileForDeletion(file: string, parentRoot: string, expectedId: string): boolean {
  try {
    const checked = safeRealFile(file, parentRoot);
    return checked === realpathSync(file) && readHeader(file)?.id === expectedId;
  } catch { return false; }
}

export function deleteValidatedSubagents(
  children: DiscoveredSubagent[],
  parentRoot: string,
  invalidatePath: (id: string) => void,
): number {
  let skipped = 0;
  for (const child of [...children].sort((a, b) => b.path.length - a.path.length)) {
    try {
      if (!validateSubagentFileForDeletion(child.path, parentRoot, child.header.id)) {
        skipped++;
        continue;
      }
      // 删除前再次取得 realpath，避免路径在验证后被替换到受控根之外。
      const real = realpathSync(child.path);
      const root = realpathSync(parentRoot);
      const rel = relative(root, real);
      if (!rel || rel.startsWith("..") || rel.includes("/../") || rel.includes("\\..\\")) {
        skipped++;
        continue;
      }
      unlinkSync(child.path);
      invalidatePath(child.header.id);
      let directory = dirname(child.path);
      for (let level = 0; level < 4; level++) {
        try {
          const directoryStat = lstatSync(directory);
          if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) break;
          rmdirSync(directory);
        } catch { break; }
        directory = dirname(directory);
      }
    } catch { skipped++; }
  }
  return skipped;
}

function parseMetadataLine(line: string, candidates: MetadataCandidate[]): void {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  if (!record(value) || value.type !== "message" || !record(value.message) ||
    value.message.role !== "toolResult" || value.message.toolName !== "subagent" ||
    !record(value.message.details) || !Array.isArray(value.message.details.results)) return;
  const details = value.message.details as Record<string, unknown>;
  const results = details.results as unknown[];
  for (const result of results) {
    if (record(result) && typeof result.sessionFile === "string") {
      candidates.push({
        path: result.sessionFile,
        runId: typeof details.runId === "string" ? details.runId : undefined,
        agent: typeof result.agent === "string" ? result.agent : typeof details.agent === "string" ? details.agent : undefined,
      });
      }
  }
}

function fallbackPaths(parentFile: string): string[] {
  const root = parentFile.endsWith(".jsonl") ? parentFile.slice(0, -6) : "";
  const result: string[] = [];
  if (!root) return result;
  try {
    for (const runId of readdirSync(root, { withFileTypes: true })) {
      if (!runId.isDirectory() || runId.isSymbolicLink() || !HEX_RUN.test(runId.name)) continue;
      const runRoot = join(root, runId.name);
      for (const run of readdirSync(runRoot, { withFileTypes: true })) {
        if (!run.isDirectory() || run.isSymbolicLink() || !RUN_DIR.test(run.name)) continue;
        result.push(join(runRoot, run.name, "session.jsonl"));
        if (result.length >= MAX_SCAN_ENTRIES) return result;
      }
    }
  } catch { /* 回退扫描失败即安全忽略 */ }
  return result;
}

export function discoverSubagentSessions(parentFile: string, parentId: string): DiscoveredSubagent[] {
  const parentRoot = parentFile.endsWith(".jsonl") ? parentFile.slice(0, -6) : "";
  if (!parentRoot) return [];
  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();
  const found: DiscoveredSubagent[] = [];
  const candidates: MetadataCandidate[] = [...metadataPaths(parentFile), ...fallbackPaths(parentFile).map((path) => ({ path }))];
  for (const candidate of candidates) {
    if (found.length >= MAX_CHILDREN) break;
    const absolute = resolve(candidate.path);
    const file = safeRealFile(absolute, parentRoot);
    if (!file || !isStrictLayout(file, parentRoot) || seenPaths.has(file)) continue;
    const index = runIndex(file);
    if (index === null || index < 0) continue;
    const header = readHeader(file);
    if (!header || seenIds.has(header.id) || header.id === parentId) continue;
    // 防止同一条祖先链被恶意 header 重新指回自身。
    const runId = candidate.runId ?? basename(dirname(dirname(file)));
    seenPaths.add(file);
    seenIds.add(header.id);
    found.push({ path: file, header, runIndex: index, parentSessionId: parentId, runId, agent: candidate.agent });
  }
  return found;
}

export function collectSubagentTree(parentFile: string, parentId: string): DiscoveredSubagent[] {
  const all: DiscoveredSubagent[] = [];
  const paths = new Set<string>([resolve(parentFile)]);
  const ids = new Set<string>([parentId]);
  const queue: Array<{ file: string; id: string; depth: number }> = [{ file: parentFile, id: parentId, depth: 0 }];
  while (queue.length && all.length < MAX_CHILDREN) {
    const current = queue.shift()!;
    if (current.depth >= MAX_DEPTH) continue;
    for (const child of discoverSubagentSessions(current.file, current.id)) {
      if (paths.has(child.path) || ids.has(child.header.id)) continue;
      paths.add(child.path); ids.add(child.header.id); all.push(child);
      queue.push({ file: child.path, id: child.header.id, depth: current.depth + 1 });
    }
  }
  return all;
}
