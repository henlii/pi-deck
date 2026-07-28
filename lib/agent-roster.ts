/**
 * Subagent 花名册与 run-history 只读 seam。
 * 镜像 pi-subagents 0.35.1 的发现路径与 run-history.jsonl 格式；
 * 不 import 扩展源码、不写盘、不扩大 /api/files allow-list。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AgentSource = "builtin" | "package" | "user" | "project";

export interface AgentRosterEntry {
  name: string;
  description: string;
  source: AgentSource;
  filePath: string;
  model?: string;
  fallbackModels?: string[];
  thinking?: string | false;
  tools?: string[];
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  disabled?: boolean;
  defaultContext?: "fresh" | "fork";
}

export interface RunHistoryEntry {
  agent: string;
  task: string;
  ts: number;
  status: "ok" | "error";
  duration: number;
  exit?: number;
}

export interface AgentRosterSnapshot {
  agentRoot: string;
  agents: AgentRosterEntry[];
  counts: {
    total: number;
    bySource: Partial<Record<AgentSource, number>>;
  };
  history: RunHistoryEntry[];
  historyPath: string;
  historyAvailable: boolean;
}

export const DEFAULT_HISTORY_LIMIT = 30;
export const MAX_HISTORY_LIMIT = 100;
export const MAX_HISTORY_FILE_BYTES = 512 * 1024;
export const MAX_AGENT_FILE_BYTES = 256 * 1024;
export const MAX_AGENTS_PER_DIR = 128;
export const MAX_AGENT_DIRS = 64;
export const MAX_TASK_PREVIEW = 200;

/** 可注入的文件系统依赖（测试 fixture） */
export interface AgentRosterFs {
  readdirSync(dir: string): string[];
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
  fstatSync?(fd: number): fs.Stats;
  existsSync?(p: string): boolean;
  constants: { O_RDONLY: number; O_NOFOLLOW?: number };
}

const defaultFs: AgentRosterFs = {
  readdirSync: (dir) => fs.readdirSync(dir),
  lstatSync: (p) => fs.lstatSync(p),
  realpathSync: (p) => fs.realpathSync(p),
  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
  openSync: (p, flags) => fs.openSync(p, flags),
  readSync: (fd, buffer, offset, length, position) =>
    fs.readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => fs.closeSync(fd),
  fstatSync: (fd) => fs.fstatSync(fd),
  existsSync: (p) => fs.existsSync(p),
  constants: fs.constants,
};

export interface ResolveAgentRootOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}

/**
 * 镜像 pi getAgentDir：PI_CODING_AGENT_DIR 优先，否则 ~/.pi/agent。
 */
export function resolveAgentRoot(options?: ResolveAgentRootOptions): string {
  const env = options?.env ?? process.env;
  const homedir = options?.homedir ?? os.homedir;
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (configured) {
    return path.resolve(expandHome(configured, homedir));
  }
  return path.join(homedir(), ".pi", "agent");
}

function expandHome(input: string, homedir: () => string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(homedir(), input.slice(2));
  }
  return input;
}

export function parseHistoryLimit(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_HISTORY_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_HISTORY_LIMIT) return null;
  return n;
}

/**
 * 解析 YAML 风格 frontmatter（简化版，对齐 pi-subagents parseFrontmatter 常用路径）。
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const frontmatter: Record<string, string> = {};
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter, body: normalized };
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter, body: normalized };
  }
  const block = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();
  let currentKey: string | null = null;
  let currentLines: string[] | null = null;
  let currentIndent = 0;

  const flush = () => {
    if (currentKey === null || currentLines === null) return;
    const raw = currentLines.join("\n");
    const leading = raw.match(/^[ \t]+(?=\S)/m)?.[0] ?? "";
    const stripped = leading
      ? raw.replace(new RegExp(`^${escapeRegex(leading)}`, "gm"), "").replace(/^\n/, "")
      : raw;
    frontmatter[currentKey] = stripped.trim();
    currentKey = null;
    currentLines = null;
    currentIndent = 0;
  };

  for (const line of block.split("\n")) {
    const indent = line.search(/\S|$/);
    const trimmed = line.trim();
    if (currentKey !== null && currentLines !== null && (indent > currentIndent || trimmed === "")) {
      currentLines.push(line);
      continue;
    }
    flush();
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) continue;
    const rawValue = match[2].trim();
    const isQuoted =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"));
    const value = isQuoted ? rawValue.slice(1, -1) : rawValue;
    if (value === "" || (!isQuoted && (rawValue === ">" || rawValue === ">-"))) {
      currentKey = match[1];
      currentLines = [];
      currentIndent = indent;
    } else {
      frontmatter[match[1]] = value;
    }
  }
  flush();
  return { frontmatter, body };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 逗号或 `- item` 列表 */
export function parseFrontmatterList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw
    .split("\n")
    .flatMap((line) => {
      const value = line.trim();
      const listItem = value.match(/^-\s+(.+)$/);
      return (listItem?.[1] ?? value).split(",");
    })
    .map((value) => value.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
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

function isDirectory(io: AgentRosterFs, p: string): boolean {
  try {
    const st = io.lstatSync(p);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch {
    return false;
  }
}

function listMdFiles(io: AgentRosterFs, dir: string, rootReal: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0 && out.length < MAX_AGENTS_PER_DIR) {
    const current = stack.pop()!;
    let names: string[];
    try {
      names = io.readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = path.join(current, name);
      let st: fs.Stats;
      try {
        st = io.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (!name.endsWith(".md") || name.endsWith(".chain.md")) continue;
      // 跳过 legacy skill 路径：.../skills/<name>/SKILL.md 等
      if (name.toLowerCase() === "skill.md") continue;
      try {
        const real = io.realpathSync(full);
        if (!isPathInsideRoot(real, rootReal) && !isPathInsideRoot(real, path.resolve(dir))) {
          // 允许目录自身 realpath 与 dir 对齐
          const dirReal = io.realpathSync(dir);
          if (!isPathInsideRoot(real, dirReal)) continue;
        }
      } catch {
        continue;
      }
      out.push(full);
      if (out.length >= MAX_AGENTS_PER_DIR) break;
    }
  }
  return out;
}

function readTextBounded(
  io: AgentRosterFs,
  filePath: string,
  maxBytes: number,
): string | null {
  try {
    const lst = io.lstatSync(filePath);
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
    if (lst.size > maxBytes) {
      // 超限：只读前 maxBytes
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

/**
 * 从文件**尾部**读取最多 maxBytes 字节，并丢弃首行（可能被 UTF-8 截断）。
 * 用于 append-only 的 run-history.jsonl：保证读到的是最新记录。
 */
function readTextTailBounded(
  io: AgentRosterFs,
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
      // 首行可能不完整（半截 UTF-8 / 半截 JSON），丢弃到第一个换行
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

/**
 * 从单个 agent .md 投影为花名册条目；缺 name/description 则跳过。
 */
export function parseAgentMarkdown(
  content: string,
  source: AgentSource,
  filePath: string,
): AgentRosterEntry | null {
  const { frontmatter } = parseFrontmatter(content);
  const name = frontmatter.name?.trim();
  const description = frontmatter.description?.trim();
  if (!name || !description) return null;

  const tools = parseFrontmatterList(frontmatter.tools);
  const fallbackModels = parseFrontmatterList(frontmatter.fallbackModels);
  const systemPromptMode =
    frontmatter.systemPromptMode === "replace" || frontmatter.systemPromptMode === "append"
      ? frontmatter.systemPromptMode
      : undefined;
  const inheritProjectContext =
    frontmatter.inheritProjectContext === "true"
      ? true
      : frontmatter.inheritProjectContext === "false"
        ? false
        : undefined;
  const inheritSkills =
    frontmatter.inheritSkills === "true"
      ? true
      : frontmatter.inheritSkills === "false"
        ? false
        : undefined;
  const defaultContext =
    frontmatter.defaultContext === "fork" || frontmatter.defaultContext === "fresh"
      ? frontmatter.defaultContext
      : undefined;
  const disabled = frontmatter.disabled === "true" ? true : undefined;
  const thinking =
    frontmatter.thinking === "false"
      ? false
      : frontmatter.thinking
        ? frontmatter.thinking
        : undefined;

  return {
    name,
    description,
    source,
    filePath,
    ...(frontmatter.model ? { model: frontmatter.model } : {}),
    ...(fallbackModels ? { fallbackModels } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(tools ? { tools } : {}),
    ...(systemPromptMode ? { systemPromptMode } : {}),
    ...(inheritProjectContext !== undefined ? { inheritProjectContext } : {}),
    ...(inheritSkills !== undefined ? { inheritSkills } : {}),
    ...(disabled ? { disabled } : {}),
    ...(defaultContext ? { defaultContext } : {}),
  };
}

function loadAgentsFromDir(
  io: AgentRosterFs,
  dir: string,
  source: AgentSource,
): AgentRosterEntry[] {
  if (!isDirectory(io, dir)) return [];
  let rootReal: string;
  try {
    rootReal = io.realpathSync(dir);
  } catch {
    return [];
  }
  const files = listMdFiles(io, dir, rootReal);
  const agents: AgentRosterEntry[] = [];
  for (const filePath of files) {
    const content = readTextBounded(io, filePath, MAX_AGENT_FILE_BYTES);
    if (content === null) continue;
    try {
      const entry = parseAgentMarkdown(content, source, filePath);
      if (entry) agents.push(entry);
    } catch {
      // 损坏 frontmatter 跳过
    }
  }
  return agents;
}

function findNearestProjectRoot(
  cwd: string,
  io: AgentRosterFs,
  homedir: () => string,
): string | null {
  let current: string;
  try {
    current = path.resolve(cwd);
  } catch {
    return null;
  }
  const home = path.resolve(homedir());
  const stop = path.parse(current).root;
  while (true) {
    // 项目根仅认 .git/.pi；.agents 不单独作为 projectRoot 判定标志，
    // 否则 cwd 不在 git 仓内、home 有 .agents 时会误命中并重复列入 project。
    if (
      isDirectory(io, path.join(current, ".git")) ||
      isDirectory(io, path.join(current, ".pi"))
    ) {
      return current;
    }
    if (current === home || current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function collectPackageAgentDirs(io: AgentRosterFs, nodeModules: string): string[] {
  if (!isDirectory(io, nodeModules)) return [];
  const out: string[] = [];
  let names: string[];
  try {
    names = io.readdirSync(nodeModules);
  } catch {
    return [];
  }
  for (const name of names) {
    if (out.length >= MAX_AGENT_DIRS) break;
    if (name.startsWith(".")) continue;
    const entry = path.join(nodeModules, name);
    if (name.startsWith("@")) {
      let scoped: string[];
      try {
        scoped = io.readdirSync(entry);
      } catch {
        continue;
      }
      for (const pkg of scoped) {
        if (out.length >= MAX_AGENT_DIRS) break;
        const agentsDir = path.join(entry, pkg, "agents");
        if (isDirectory(io, agentsDir)) out.push(agentsDir);
      }
      continue;
    }
    const agentsDir = path.join(entry, "agents");
    if (isDirectory(io, agentsDir)) out.push(agentsDir);
  }
  return out;
}

function dedupeByNamePreferLater(entries: AgentRosterEntry[]): AgentRosterEntry[] {
  // 同名后出现者覆盖（project > user > package > builtin 的合并在调用方控制顺序）
  const map = new Map<string, AgentRosterEntry>();
  for (const entry of entries) {
    map.set(entry.name, entry);
  }
  return Array.from(map.values());
}

export interface ListAgentRosterOptions {
  cwd?: string | null;
  fs?: AgentRosterFs;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  /** 可注入 builtin 目录（测试）；生产从 agentRoot/npm/.../pi-subagents/agents 推导 */
  builtinDir?: string | null;
  historyLimit?: number;
}

/**
 * 枚举 agent 花名册 + 有界 run-history（只读）。
 */
export function listAgentRoster(options: ListAgentRosterOptions = {}): AgentRosterSnapshot {
  const io = options.fs ?? defaultFs;
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir;
  const agentRoot = resolveAgentRoot({ env, homedir });
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;

  const userAgentsDir = path.join(agentRoot, "agents");
  const userAgentsLegacy = path.join(homedir(), ".agents");
  const builtinDir =
    options.builtinDir !== undefined
      ? options.builtinDir
      : path.join(agentRoot, "npm", "node_modules", "pi-subagents", "agents");

  const packageDirs = collectPackageAgentDirs(
    io,
    path.join(agentRoot, "npm", "node_modules"),
  ).filter((dir) => {
    // builtin 已单独枚举，避免重复
    if (builtinDir && path.resolve(dir) === path.resolve(builtinDir)) return false;
    return true;
  });

  let projectDirs: string[] = [];
  if (options.cwd != null && String(options.cwd).trim() !== "") {
    const projectRoot = findNearestProjectRoot(String(options.cwd), io, homedir);
    if (projectRoot) {
      const candidates = [
        path.join(projectRoot, ".agents"),
        path.join(projectRoot, ".pi", "agents"),
      ];
      projectDirs = candidates.filter((d) => isDirectory(io, d));
      // 项目级 npm packages
      packageDirs.push(
        ...collectPackageAgentDirs(io, path.join(projectRoot, "node_modules")),
        ...collectPackageAgentDirs(
          io,
          path.join(projectRoot, ".pi", "npm", "node_modules"),
        ),
      );
    }
  }

  const builtin = builtinDir ? loadAgentsFromDir(io, builtinDir, "builtin") : [];
  const packageAgents = packageDirs.flatMap((dir) => loadAgentsFromDir(io, dir, "package"));
  const user = [
    ...loadAgentsFromDir(io, userAgentsLegacy, "user"),
    ...loadAgentsFromDir(io, userAgentsDir, "user"),
  ];
  const project = projectDirs.flatMap((dir) => loadAgentsFromDir(io, dir, "project"));

  // 展示用：按 source 分组保留全部，同名不同 source 都可见；同 source 内去重
  const agents = [
    ...dedupeByNamePreferLater(builtin),
    ...dedupeByNamePreferLater(packageAgents),
    ...dedupeByNamePreferLater(user),
    ...dedupeByNamePreferLater(project),
  ].sort((a, b) => {
    const sourceOrder: AgentSource[] = ["builtin", "package", "user", "project"];
    const sa = sourceOrder.indexOf(a.source);
    const sb = sourceOrder.indexOf(b.source);
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });

  const bySource: Partial<Record<AgentSource, number>> = {};
  for (const agent of agents) {
    bySource[agent.source] = (bySource[agent.source] ?? 0) + 1;
  }

  const historyPath = path.join(agentRoot, "run-history.jsonl");
  const { entries: history, available: historyAvailable } = readRunHistory(io, historyPath, historyLimit);

  return {
    agentRoot,
    agents,
    counts: { total: agents.length, bySource },
    history,
    historyPath,
    historyAvailable,
  };
}

/**
 * 只读解析 run-history.jsonl 尾部；损坏行跳过。
 */
export function readRunHistory(
  io: AgentRosterFs,
  historyPath: string,
  limit: number,
): { entries: RunHistoryEntry[]; available: boolean } {
  const capped = Math.min(Math.max(1, limit), MAX_HISTORY_LIMIT);
  try {
    const lst = io.lstatSync(historyPath);
    if (lst.isSymbolicLink() || !lst.isFile()) {
      return { entries: [], available: false };
    }
  } catch (err) {
    if (isNotFound(err)) return { entries: [], available: false };
    return { entries: [], available: false };
  }

  const raw = readTextTailBounded(io, historyPath, MAX_HISTORY_FILE_BYTES);
  if (raw === null) return { entries: [], available: false };

  // 从尾部读取后，末尾即最新记录
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const parsed: RunHistoryEntry[] = [];
  // 从末尾向前取
  for (let i = lines.length - 1; i >= 0 && parsed.length < capped; i--) {
    const entry = parseRunHistoryLine(lines[i]!);
    if (entry) parsed.push(entry);
  }
  return { entries: parsed, available: true };
}

export function parseRunHistoryLine(line: string): RunHistoryEntry | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.agent !== "string" || !obj.agent.trim()) return null;
  if (typeof obj.task !== "string") return null;
  if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) return null;
  if (obj.status !== "ok" && obj.status !== "error") return null;
  if (typeof obj.duration !== "number" || !Number.isFinite(obj.duration)) return null;
  const exit =
    typeof obj.exit === "number" && Number.isFinite(obj.exit) ? obj.exit : undefined;
  return {
    agent: obj.agent,
    task: obj.task.slice(0, MAX_TASK_PREVIEW),
    ts: obj.ts,
    status: obj.status,
    duration: obj.duration,
    ...(exit !== undefined ? { exit } : {}),
  };
}
