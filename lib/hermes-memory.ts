/**
 * Hermes 记忆只读 seam：从 pi-hermes-memory 约定路径读取 MEMORY/USER/failures，
 * 绝不写盘；不扩大 /api/files allow-list。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 与 pi-hermes-memory ENTRY_DELIMITER 一致 */
export const ENTRY_DELIMITER = "\n§\n";

export const GLOBAL_MEMORY_DIRNAME = "pi-hermes-memory";
export const PROJECTS_MEMORY_DIRNAME = "projects-memory";

export const GLOBAL_WHITELIST = ["MEMORY.md", "USER.md", "failures.md"] as const;
export const PROJECT_WHITELIST = ["MEMORY.md"] as const;

/** 单文件最大读取字节；超限截断并 truncated:true */
export const MAX_MEMORY_FILE_BYTES = 256 * 1024;

/**
 * 精简移植自 pi-hermes-memory content-scanner SECRET_PATTERNS。
 * 只读路径上仅标注 sensitive，不阻止展示。
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /\bsk-ant-api\S{10,}\b/, id: "anthropic_api_key" },
  { pattern: /\bsk-or-v1-\S{10,}\b/, id: "openrouter_api_key" },
  { pattern: /\bsk-\S{20,}\b/, id: "openai_api_key" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, id: "aws_access_key" },
  { pattern: /\bghp_\S{10,}\b/, id: "github_personal_token" },
  { pattern: /\bghu_\S{10,}\b/, id: "github_user_token" },
  { pattern: /\bxoxb-\S{10,}\b/, id: "slack_bot_token" },
  { pattern: /\bxapp-\S{10,}\b/, id: "slack_app_token" },
  { pattern: /\bntn_\S{10,}\b/, id: "notion_token" },
  { pattern: /\bBearer\s+\S{20,}\b/, id: "bearer_auth_token" },
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\sKEY-----/, id: "private_key_block" },
  { pattern: /\bANTHROPIC_API_KEY\b/, id: "env_anthropic_key" },
  { pattern: /\bOPENAI_API_KEY\b/, id: "env_openai_key" },
  { pattern: /\bOPENROUTER_API_KEY\b/, id: "env_openrouter_key" },
  { pattern: /\bGITHUB_TOKEN\b/, id: "env_github_token" },
  { pattern: /\bAWS_SECRET_ACCESS_KEY\b/, id: "env_aws_secret" },
  { pattern: /\bDATABASE_URL\b/, id: "env_database_url" },
  { pattern: /\bpassword\s*[=:]\s*\S{6,}\b/i, id: "password_assignment" },
  { pattern: /\bsecret\s*[=:]\s*\S{6,}\b/i, id: "secret_assignment" },
  { pattern: /\btoken\s*[=:]\s*\S{10,}\b/i, id: "token_assignment" },
];

export interface MemoryEntry {
  text: string;
  sensitive: boolean;
  sensitiveIds: string[];
}

export interface MemorySection {
  path: string;
  exists: boolean;
  truncated: boolean;
  mtimeMs: number | null;
  size: number | null;
  entries: MemoryEntry[];
  error?: string;
}

export interface HermesMemoryProject {
  name: string;
  dir: string;
  memory: MemorySection;
}

export interface HermesMemorySnapshot {
  agentRoot: string;
  globalDir: string;
  global: {
    memory: MemorySection;
    user: MemorySection;
    failures: MemorySection;
  };
  project: HermesMemoryProject | null;
}

/** 可注入的文件系统依赖（测试 fixture） */
export interface HermesMemoryFs {
  lstatSync(p: string): fs.Stats;
  realpathSync(p: string): string;
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
  constants: { O_RDONLY: number; O_NOFOLLOW?: number };
}

const defaultFs: HermesMemoryFs = {
  lstatSync: (p) => fs.lstatSync(p),
  realpathSync: (p) => fs.realpathSync(p),
  openSync: (p, flags) => fs.openSync(p, flags),
  readSync: (fd, buffer, offset, length, position) =>
    fs.readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => fs.closeSync(fd),
  fstatSync: (fd) => fs.fstatSync(fd),
  constants: fs.constants,
};

export interface ResolveAgentRootOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}

/**
 * 镜像 pi-hermes-memory resolveAgentRoot：
 * PI_CODING_AGENT_DIR 优先，否则 ~/.pi/agent。
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

/**
 * 项目名 = basename(resolve(cwd))；
 * home、/、空 → 无项目块。
 */
export function resolveProjectName(
  cwd: string | null | undefined,
  options?: { homedir?: () => string },
): string | null {
  if (cwd == null || String(cwd).trim() === "") return null;
  const homedir = options?.homedir ?? os.homedir;
  let resolved: string;
  try {
    resolved = path.resolve(String(cwd));
  } catch {
    return null;
  }
  if (!resolved || resolved === "/") return null;
  const home = path.resolve(homedir());
  if (resolved === home || resolved === home + path.sep) return null;
  const name = path.basename(resolved);
  if (!name || name === "." || name === "..") return null;
  return name;
}

/** scanSecrets 风格：返回匹配到的 secret id 列表 */
export function scanSecrets(content: string): string[] {
  const found: string[] = [];
  for (const { pattern, id } of SECRET_PATTERNS) {
    // 每次重置 lastIndex（虽均为非 g 模式，防御性）
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      found.push(id);
    }
  }
  return found;
}

/** 按 ENTRY_DELIMITER 拆分条目并标注敏感 */
export function splitMemoryEntries(content: string): MemoryEntry[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  return content
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((text) => {
      const sensitiveIds = scanSecrets(text);
      return {
        text,
        sensitive: sensitiveIds.length > 0,
        sensitiveIds,
      };
    });
}

function isPathInsideRoot(candidate: string, rootReal: string): boolean {
  const resolved = path.resolve(candidate);
  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return resolved === rootReal || resolved.startsWith(rootWithSep);
}

/**
 * 安全打开常规文件：lstat 拒绝 symlink，realpath 必须在根内。
 * 返回 null 表示拒绝读取。
 */
function openSafeFile(
  io: HermesMemoryFs,
  filePath: string,
  rootReal: string,
): { fd: number; size: number; mtimeMs: number } | null {
  try {
    const lst = io.lstatSync(filePath);
    if (lst.isSymbolicLink()) return null;
    if (!lst.isFile()) return null;
    const real = io.realpathSync(filePath);
    if (!isPathInsideRoot(real, rootReal)) return null;
    const noFollow =
      typeof io.constants.O_NOFOLLOW === "number" ? io.constants.O_NOFOLLOW : 0;
    const fd = io.openSync(filePath, io.constants.O_RDONLY | noFollow);
    try {
      const st = io.fstatSync ? io.fstatSync(fd) : io.lstatSync(filePath);
      if (!st.isFile()) {
        io.closeSync(fd);
        return null;
      }
      return { fd, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      try {
        io.closeSync(fd);
      } catch {
        // ignore
      }
      return null;
    }
  } catch {
    return null;
  }
}

function emptySection(filePath: string, partial?: Partial<MemorySection>): MemorySection {
  return {
    path: filePath,
    exists: false,
    truncated: false,
    mtimeMs: null,
    size: null,
    entries: [],
    ...partial,
  };
}

/**
 * 只读打开白名单文件；从文件头读取，超限截断。
 * basename 必须在 allowedNames 内。
 */
export function readMemorySection(
  filePath: string,
  allowedRoot: string,
  options?: {
    fs?: HermesMemoryFs;
    maxBytes?: number;
    allowedNames?: readonly string[];
  },
): MemorySection {
  const io = options?.fs ?? defaultFs;
  const maxBytes = options?.maxBytes ?? MAX_MEMORY_FILE_BYTES;
  const allowedNames = options?.allowedNames ?? GLOBAL_WHITELIST;
  const base = path.basename(filePath);

  if (!allowedNames.includes(base as (typeof GLOBAL_WHITELIST)[number])) {
    return emptySection(filePath, {
      error: `拒绝读取非白名单文件名: ${base}`,
    });
  }

  // 解析允许根；根不存在时按缺失处理
  let rootReal: string;
  try {
    rootReal = io.realpathSync(path.resolve(allowedRoot));
  } catch {
    return emptySection(filePath);
  }

  const resolvedPath = path.resolve(filePath);

  // 打开前快速检查路径是否声称在根内（realpath 后再验）
  if (!isPathInsideRoot(resolvedPath, path.resolve(allowedRoot))) {
    return emptySection(filePath, {
      error: "路径越界",
    });
  }

  let lst: fs.Stats;
  try {
    lst = io.lstatSync(resolvedPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return emptySection(filePath);
    }
    return emptySection(filePath, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (lst.isSymbolicLink()) {
    return emptySection(filePath, {
      exists: true,
      error: "拒绝读取符号链接",
    });
  }

  if (!lst.isFile()) {
    return emptySection(filePath, {
      exists: true,
      error: "不是常规文件",
    });
  }

  const opened = openSafeFile(io, resolvedPath, rootReal);
  if (!opened) {
    return emptySection(filePath, {
      exists: true,
      error: "安全检查未通过（symlink 或越界）",
    });
  }

  const { fd, size, mtimeMs } = opened;
  try {
    if (size === 0) {
      return {
        path: filePath,
        exists: true,
        truncated: false,
        mtimeMs,
        size: 0,
        entries: [],
      };
    }
    const readLen = Math.min(maxBytes, size);
    const buf = Buffer.alloc(readLen);
    let offset = 0;
    while (offset < readLen) {
      const n = io.readSync(fd, buf, offset, readLen - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    const text = buf.subarray(0, offset).toString("utf8");
    const truncated = size > maxBytes;
    return {
      path: filePath,
      exists: true,
      truncated,
      mtimeMs,
      size,
      entries: splitMemoryEntries(text),
    };
  } catch (err) {
    return emptySection(filePath, {
      exists: true,
      mtimeMs,
      size,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    try {
      io.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

export interface ReadHermesMemoryOptions {
  cwd?: string | null;
  agentRoot?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  fs?: HermesMemoryFs;
  maxBytes?: number;
}

/**
 * 读取全局 + 可选项目记忆快照。绝不写盘。
 * cwd 非法/不存在：仍返回全局；project=null。
 */
export function readHermesMemory(
  options?: ReadHermesMemoryOptions,
): HermesMemorySnapshot {
  const agentRoot =
    options?.agentRoot ??
    resolveAgentRoot({ env: options?.env, homedir: options?.homedir });
  const globalDir = path.join(agentRoot, GLOBAL_MEMORY_DIRNAME);
  const maxBytes = options?.maxBytes;
  const io = options?.fs;

  const sectionOpts = {
    fs: io,
    maxBytes,
    allowedNames: GLOBAL_WHITELIST,
  };

  const global = {
    memory: readMemorySection(path.join(globalDir, "MEMORY.md"), globalDir, sectionOpts),
    user: readMemorySection(path.join(globalDir, "USER.md"), globalDir, sectionOpts),
    failures: readMemorySection(path.join(globalDir, "failures.md"), globalDir, sectionOpts),
  };

  const projectName = resolveProjectName(options?.cwd, {
    homedir: options?.homedir,
  });

  let project: HermesMemoryProject | null = null;
  if (projectName) {
    const projectDir = path.join(agentRoot, PROJECTS_MEMORY_DIRNAME, projectName);
    project = {
      name: projectName,
      dir: projectDir,
      memory: readMemorySection(path.join(projectDir, "MEMORY.md"), projectDir, {
        fs: io,
        maxBytes,
        allowedNames: PROJECT_WHITELIST,
      }),
    };
  }

  return {
    agentRoot,
    globalDir,
    global,
    project,
  };
}
