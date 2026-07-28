/**
 * pi-lens 诊断只读 seam：从项目数据目录读取 lsp-workspace-diagnostics 缓存，
 * 可选有界读取全局 code-quality-warnings.jsonl 尾部。
 * 不写盘、不启动 LSP、不扩大 /api/files allow-list。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** LSP DiagnosticSeverity：1 error · 2 warning · 3 info · 4 hint */
export type LensSeverity = "error" | "warning" | "info" | "hint";

export interface LensDiagnosticItem {
  filePath: string;
  /** 相对 cwd 的展示路径（无法相对化时回退 basename） */
  displayPath: string;
  line: number;
  character: number;
  severity: LensSeverity;
  message: string;
  source?: string;
  code?: string;
}

export interface LensDiagnosticsFileGroup {
  filePath: string;
  displayPath: string;
  count: number;
  bySeverity: Partial<Record<LensSeverity, number>>;
  items: LensDiagnosticItem[];
}

export interface LensQualityWarning {
  timestamp?: string;
  filePath: string;
  displayPath: string;
  line?: number;
  severity: LensSeverity;
  message: string;
  tool?: string;
  rule?: string;
  category?: string;
}

export interface LensDiagnosticsSnapshot {
  cwd: string;
  dataDir: string;
  cachePath: string;
  cacheAvailable: boolean;
  scannedAt: number | null;
  files: LensDiagnosticsFileGroup[];
  counts: {
    total: number;
    files: number;
    bySeverity: Partial<Record<LensSeverity, number>>;
  };
  qualityWarnings: LensQualityWarning[];
  qualityLogPath: string;
  qualityAvailable: boolean;
}

export const MAX_CACHE_BYTES = 2 * 1024 * 1024;
export const MAX_QUALITY_TAIL_BYTES = 64 * 1024;
export const MAX_QUALITY_ITEMS = 40;
export const MAX_ITEMS_PER_FILE = 30;
export const MAX_FILES = 80;
export const MAX_TOTAL_ITEMS = 200;

export interface LensDiagnosticsFs {
  readdirSync?(dir: string): string[];
  lstatSync(p: string): fs.Stats;
  realpathSync(p: string): string;
  readFileSync(p: string, encoding: "utf8"): string;
  openSync(p: string, flags: number): number;
  readSync(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): number;
  closeSync(fd: number): void;
  existsSync?(p: string): boolean;
  constants: { O_RDONLY: number; O_NOFOLLOW?: number };
}

const defaultFs: LensDiagnosticsFs = {
  readdirSync: (dir) => fs.readdirSync(dir),
  lstatSync: (p) => fs.lstatSync(p),
  realpathSync: (p) => fs.realpathSync(p),
  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
  openSync: (p, flags) => fs.openSync(p, flags),
  readSync: (fd, buffer, offset, length, position) =>
    fs.readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => fs.closeSync(fd),
  existsSync: (p) => fs.existsSync(p),
  constants: fs.constants,
};

export interface ResolveLensDataDirOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  fs?: Pick<LensDiagnosticsFs, "existsSync" | "lstatSync">;
}

/**
 * 镜像 pi-lens getProjectDataDir：
 * 1. PILENS_DATA_DIR/<slug>
 * 2. <cwd>/.pi-lens（仅当已存在）
 * 3. ~/.pi-lens/projects/<slug>
 */
export function resolveLensDataDir(
  cwd: string,
  options?: ResolveLensDataDirOptions,
): string {
  const env = options?.env ?? process.env;
  const homedir = options?.homedir ?? os.homedir;
  const io = options?.fs ?? defaultFs;
  const resolved = path.resolve(cwd);
  const legacy = path.join(resolved, ".pi-lens");
  const configuredBase = env.PILENS_DATA_DIR?.trim();

  if (!configuredBase) {
    try {
      if (io.existsSync?.(legacy)) {
        const st = io.lstatSync(legacy);
        if (!st.isSymbolicLink() && st.isDirectory()) return legacy;
      }
    } catch {
      // fall through
    }
  }

  const base =
    configuredBase && configuredBase.length > 0
      ? expandHome(configuredBase, homedir)
      : path.join(homedir(), ".pi-lens", "projects");
  return path.join(base, slugifyCwd(resolved));
}

function expandHome(input: string, homedir: () => string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(homedir(), input.slice(2));
  }
  return path.resolve(input);
}

/** 与 pi-lens file-utils slug 规则对齐 */
export function slugifyCwd(cwd: string): string {
  const normalized = path.resolve(cwd).replace(/\\/g, "/");
  const slug = normalized
    .replace(/^[a-z]:/i, "")
    .replace(/\/+/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return slug || "default";
}

export function mapLspSeverity(value: unknown): LensSeverity {
  if (value === 1 || value === "error") return "error";
  if (value === 2 || value === "warning") return "warning";
  if (value === 3 || value === "info") return "info";
  if (value === 4 || value === "hint") return "hint";
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "error") return "error";
    if (lower === "warning" || lower === "warn") return "warning";
    if (lower === "info" || lower === "information") return "info";
    if (lower === "hint") return "hint";
  }
  return "warning";
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isPathInsideRoot(candidate: string, rootReal: string): boolean {
  const resolved = path.resolve(candidate);
  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return resolved === rootReal || resolved.startsWith(rootWithSep);
}

function readTextTailBounded(
  io: LensDiagnosticsFs,
  filePath: string,
  maxBytes: number,
): string | null {
  try {
    const lst = io.lstatSync(filePath);
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
    const noFollow =
      typeof io.constants.O_NOFOLLOW === "number" ? io.constants.O_NOFOLLOW : 0;
    if (lst.size <= maxBytes) {
      return io.readFileSync(filePath, "utf8");
    }
    const fd = io.openSync(filePath, io.constants.O_RDONLY | noFollow);
    try {
      const start = lst.size - maxBytes;
      const buf = Buffer.alloc(maxBytes);
      const n = io.readSync(fd, buf, 0, maxBytes, start);
      const text = buf.subarray(0, n).toString("utf8");
      const firstNewline = text.indexOf("\n");
      return firstNewline === -1 ? text : text.slice(firstNewline + 1);
    } finally {
      try {
        io.closeSync(fd);
      } catch {
        // ignore
      }
    }
  } catch {
    return null;
  }
}

function readTextBounded(
  io: LensDiagnosticsFs,
  filePath: string,
  maxBytes: number,
): string | null {
  try {
    const lst = io.lstatSync(filePath);
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
    if (lst.size > maxBytes) {
      const noFollow =
        typeof io.constants.O_NOFOLLOW === "number" ? io.constants.O_NOFOLLOW : 0;
      const fd = io.openSync(filePath, io.constants.O_RDONLY | noFollow);
      try {
        const buf = Buffer.alloc(maxBytes);
        const n = io.readSync(fd, buf, 0, maxBytes, 0);
        return buf.subarray(0, n).toString("utf8");
      } finally {
        try {
          io.closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
    return io.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function displayPathFor(filePath: string, cwd: string): string {
  try {
    const rel = path.relative(cwd, filePath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.replace(/\\/g, "/");
  } catch {
    // fall through
  }
  return path.basename(filePath) || filePath;
}

function severityRank(s: LensSeverity): number {
  switch (s) {
    case "error":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
    case "hint":
      return 3;
  }
}

/**
 * 解析 lsp-workspace-diagnostics.json 缓存为有界投影。
 */
export function parseLspWorkspaceCache(
  raw: unknown,
  cwd: string,
): { files: LensDiagnosticsFileGroup[]; scannedAt: number | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { files: [], scannedAt: null };
  }
  const obj = raw as Record<string, unknown>;
  const entries = obj.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return { files: [], scannedAt: null };
  }

  let scannedAt: number | null = null;
  const groups: LensDiagnosticsFileGroup[] = [];

  for (const [filePath, entry] of Object.entries(entries as Record<string, unknown>)) {
    if (!filePath || typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec.scannedAt === "number" && Number.isFinite(rec.scannedAt)) {
      scannedAt = scannedAt === null ? rec.scannedAt : Math.max(scannedAt, rec.scannedAt);
    }
    const diags = Array.isArray(rec.diagnostics) ? rec.diagnostics : [];
    const items: LensDiagnosticItem[] = [];
    const bySeverity: Partial<Record<LensSeverity, number>> = {};

    for (const d of diags) {
      if (items.length >= MAX_ITEMS_PER_FILE) break;
      if (!d || typeof d !== "object" || Array.isArray(d)) continue;
      const diag = d as Record<string, unknown>;
      if (typeof diag.message !== "string" || !diag.message.trim()) continue;
      const severity = mapLspSeverity(diag.severity);
      let line = 1;
      let character = 0;
      const range = diag.range;
      if (range && typeof range === "object" && !Array.isArray(range)) {
        const start = (range as Record<string, unknown>).start;
        if (start && typeof start === "object" && !Array.isArray(start)) {
          const s = start as Record<string, unknown>;
          if (typeof s.line === "number" && Number.isFinite(s.line)) {
            // LSP 0-based → 展示 1-based
            line = Math.max(1, Math.floor(s.line) + 1);
          }
          if (typeof s.character === "number" && Number.isFinite(s.character)) {
            character = Math.max(0, Math.floor(s.character));
          }
        }
      }
      const code =
        typeof diag.code === "string" || typeof diag.code === "number"
          ? String(diag.code)
          : undefined;
      const source = typeof diag.source === "string" ? diag.source : undefined;
      items.push({
        filePath,
        displayPath: displayPathFor(filePath, cwd),
        line,
        character,
        severity,
        message: diag.message.trim().slice(0, 500),
        ...(source ? { source } : {}),
        ...(code ? { code } : {}),
      });
      bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
    }

    if (items.length === 0) continue;
    items.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.line - b.line);
    groups.push({
      filePath,
      displayPath: displayPathFor(filePath, cwd),
      count: items.length,
      bySeverity,
      items,
    });
  }

  // 错误优先，再按 count 降序
  groups.sort((a, b) => {
    const ae = a.bySeverity.error ?? 0;
    const be = b.bySeverity.error ?? 0;
    if (be !== ae) return be - ae;
    const aw = a.bySeverity.warning ?? 0;
    const bw = b.bySeverity.warning ?? 0;
    if (bw !== aw) return bw - aw;
    return b.count - a.count;
  });

  return { files: groups.slice(0, MAX_FILES), scannedAt };
}

export function parseQualityWarningLine(line: string, cwd: string): LensQualityWarning | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.message !== "string" || !obj.message.trim()) return null;
  const filePath =
    typeof obj.filePath === "string" && obj.filePath
      ? obj.filePath
      : typeof obj.displayPath === "string"
        ? obj.displayPath
        : "unknown";
  return {
    ...(typeof obj.timestamp === "string" ? { timestamp: obj.timestamp } : {}),
    filePath,
    displayPath:
      typeof obj.displayPath === "string" && obj.displayPath
        ? obj.displayPath
        : displayPathFor(filePath, cwd),
    ...(typeof obj.line === "number" && Number.isFinite(obj.line)
      ? { line: Math.max(1, Math.floor(obj.line)) }
      : {}),
    severity: mapLspSeverity(obj.severity),
    message: obj.message.trim().slice(0, 500),
    ...(typeof obj.tool === "string" ? { tool: obj.tool } : {}),
    ...(typeof obj.rule === "string" ? { rule: obj.rule } : {}),
    ...(typeof obj.category === "string" ? { category: obj.category } : {}),
  };
}

export interface ListLensDiagnosticsOptions {
  cwd: string;
  fs?: LensDiagnosticsFs;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  /** 可注入 dataDir（测试） */
  dataDir?: string;
  qualityLogPath?: string;
}

/**
 * 只读枚举 pi-lens 诊断缓存 + 质量警告尾部。
 */
export function listLensDiagnostics(
  options: ListLensDiagnosticsOptions,
): LensDiagnosticsSnapshot {
  const io = options.fs ?? defaultFs;
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir;
  const cwd = path.resolve(options.cwd);
  const dataDir =
    options.dataDir ?? resolveLensDataDir(cwd, { env, homedir, fs: io });
  const cachePath = path.join(dataDir, "cache", "lsp-workspace-diagnostics.json");
  const qualityLogPath =
    options.qualityLogPath ?? path.join(homedir(), ".pi-lens", "code-quality-warnings.jsonl");

  let cacheAvailable = false;
  let files: LensDiagnosticsFileGroup[] = [];
  let scannedAt: number | null = null;

  try {
    const lst = io.lstatSync(cachePath);
    if (!lst.isSymbolicLink() && lst.isFile()) {
      // 可选：realpath 必须在 dataDir 内
      try {
        const dataReal = io.realpathSync(dataDir);
        const cacheReal = io.realpathSync(cachePath);
        if (isPathInsideRoot(cacheReal, dataReal)) {
          const rawText = readTextBounded(io, cachePath, MAX_CACHE_BYTES);
          if (rawText !== null) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(rawText);
            } catch {
              parsed = null;
            }
            if (parsed) {
              const projected = parseLspWorkspaceCache(parsed, cwd);
              files = projected.files;
              scannedAt = projected.scannedAt;
              cacheAvailable = true;
            }
          }
        }
      } catch {
        // 目录不可读 → 空
      }
    }
  } catch (err) {
    if (!isNotFound(err)) {
      // 其它错误当不可用
    }
  }

  // 有界总条目
  let totalItems = 0;
  const cappedFiles: LensDiagnosticsFileGroup[] = [];
  for (const group of files) {
    if (totalItems >= MAX_TOTAL_ITEMS) break;
    const remaining = MAX_TOTAL_ITEMS - totalItems;
    const items = group.items.slice(0, remaining);
    totalItems += items.length;
    const bySeverity: Partial<Record<LensSeverity, number>> = {};
    for (const item of items) {
      bySeverity[item.severity] = (bySeverity[item.severity] ?? 0) + 1;
    }
    cappedFiles.push({
      ...group,
      items,
      count: items.length,
      bySeverity,
    });
  }

  const bySeverity: Partial<Record<LensSeverity, number>> = {};
  for (const group of cappedFiles) {
    for (const [sev, n] of Object.entries(group.bySeverity) as Array<[LensSeverity, number]>) {
      bySeverity[sev] = (bySeverity[sev] ?? 0) + n;
    }
  }

  // 全局 quality warnings 尾部
  let qualityAvailable = false;
  const qualityWarnings: LensQualityWarning[] = [];
  try {
    const lst = io.lstatSync(qualityLogPath);
    if (!lst.isSymbolicLink() && lst.isFile()) {
      const raw = readTextTailBounded(io, qualityLogPath, MAX_QUALITY_TAIL_BYTES);
      if (raw !== null) {
        qualityAvailable = true;
        const lines = raw
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        for (let i = lines.length - 1; i >= 0 && qualityWarnings.length < MAX_QUALITY_ITEMS; i--) {
          const item = parseQualityWarningLine(lines[i]!, cwd);
          if (item) qualityWarnings.push(item);
        }
      }
    }
  } catch (err) {
    if (!isNotFound(err)) {
      // ignore
    }
  }

  return {
    cwd,
    dataDir,
    cachePath,
    cacheAvailable,
    scannedAt,
    files: cappedFiles,
    counts: {
      total: totalItems,
      files: cappedFiles.length,
      bySeverity,
    },
    qualityWarnings,
    qualityLogPath,
    qualityAvailable,
  };
}
