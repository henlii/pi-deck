import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import type {
  GitFileDiffResponse,
  GitFileStatus,
  GitStatusResponse,
} from "./git-types";
import {
  classifyGitStatus,
  parseGitPorcelainV1,
  type GitPorcelainEntry,
} from "./git-status";
import { buildDiffCacheKey } from "./git-refresh";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;

// ============================================================================
// Git 数据响应缓存（P1-3 定向刷新 + P1-6 HEAD 校验）
//
// diff 与 status 分离缓存、分离失效：
//   - diff：按 (cwd, filePath) 键控，以 (mtimeMs, size, head) 校验——
//     文件未变且仓库 HEAD 未变时同内容重复请求零 diff/status git 调用；
//     单文件修改只重抓该文件（mtime/size 变化即定向失效该条目）。
//   - HEAD 校验：diff 基线是 `git diff HEAD`，切换分支 / reset / checkout
//     后 HEAD 变化而工作树文件未变时，仅凭 mtime/size 会返回旧 diff；
//     因此每次请求用同一次 `git rev-parse --show-toplevel HEAD` 批量取
//     HEAD 标识并入校验，HEAD 不匹配即整体失效该仓库条目。
//   - status：按 cwd 键控的短 TTL 防抖——聚合视图在全量刷新场景（agent
//     结束后 / 文件保存后）合并高频重复请求，但不与 diff 缓存互相污染。
// 缓存为模块级 Map（热重载自动清空，丢失无害，仅影响下次冷抓速度）。
// ============================================================================

interface GitDiffCacheEntry {
  mtimeMs: number;
  size: number;
  /** 缓存生成时的 HEAD 标识（unborn HEAD 为 null）；HEAD 变化即条目失效。 */
  head: string | null;
  response: GitFileDiffResponse;
}

interface GitStatusCacheEntry {
  fetchedAt: number;
  response: GitStatusResponse;
}

const gitDiffCache = new Map<string, GitDiffCacheEntry>();
const gitStatusCache = new Map<string, GitStatusCacheEntry>();
const STATUS_CACHE_TTL_MS = 800;

/** 定向失效单文件 diff 缓存条目（文件保存/删除等明确知道路径的事件用）。 */
export function invalidateGitFileDiff(cwd: string, filePath: string): void {
  gitDiffCache.delete(buildDiffCacheKey(cwd, filePath));
}

/** 失效某 cwd 的 status 缓存（该仓库内容已变化时用）。 */
export function invalidateGitStatus(cwd: string): void {
  gitStatusCache.delete(cwd);
}

async function git(cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

/** 仓库根 + 当前 HEAD 标识，一次 rev-parse 批量获取（P1-6）。 */
interface RepositoryInfo {
  repositoryRoot: string;
  head: string | null;
}

async function findRepositoryInfo(cwd: string): Promise<RepositoryInfo | null> {
  try {
    // `--show-toplevel` 与 `HEAD` 同一次调用分别输出到独立行，省一次进程开销。
    const output = (await git(cwd, ["rev-parse", "--show-toplevel", "HEAD"])).trim();
    const [repositoryRoot, head] = output.split("\n");
    if (!repositoryRoot) return null;
    return { repositoryRoot, head: head?.trim() || null };
  } catch {
    // unborn HEAD（仓库尚无提交）：HEAD 无法解析，回退只取 toplevel，
    // head 记 null——无提交时 diff 无基线，仅 untracked 文件可出 patch。
    try {
      const repositoryRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
      return repositoryRoot ? { repositoryRoot, head: null } : null;
    } catch {
      return null;
    }
  }
}

function isWithinPath(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function readStatusEntries(repositoryRoot: string): Promise<GitPorcelainEntry[]> {
  const output = await git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return parseGitPorcelainV1(output);
}

export async function getGitStatus(cwd: string): Promise<GitStatusResponse> {
  const now = Date.now();
  const cached = gitStatusCache.get(cwd);
  if (cached && now - cached.fetchedAt < STATUS_CACHE_TTL_MS) {
    return cached.response;
  }
  const response = await getGitStatusUncached(cwd);
  gitStatusCache.set(cwd, { fetchedAt: now, response });
  return response;
}

async function getGitStatusUncached(cwd: string): Promise<GitStatusResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) {
    return { isGitRepository: false, repositoryRoot: null, files: [] };
  }

  const entries = await readStatusEntries(repositoryRoot);
  const files = entries.flatMap((entry): GitFileStatus[] => {
    const filePath = path.resolve(repositoryRoot, entry.path);
    if (!isWithinPath(cwd, filePath)) return [];
    const classified = classifyGitStatus(entry);
    return [{
      filePath,
      ...classified,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
    }];
  });

  return { isGitRepository: true, repositoryRoot, files };
}

function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function createAddedFilePatch(gitPath: string, content: string): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0
    ? "\n\\ No newline at end of file"
    : "";
  return [
    `diff --git a/${gitPath} b/${gitPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`,
  ].join("\n");
}

async function createTrackedFilePatch(
  repositoryRoot: string,
  relativePath: string,
  originalPath?: string,
): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath
    ? [originalPath, relativePath]
    : [relativePath];
  try {
    return await git(repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
      "HEAD",
      "--",
      ...paths,
    ], TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    return null;
  }
}

export async function getGitFileDiff(
  cwd: string,
  filePath: string,
  options: { force?: boolean } = {},
): Promise<GitFileDiffResponse> {
  const repositoryInfo = await findRepositoryInfo(cwd);
  if (!repositoryInfo || !isWithinPath(repositoryInfo.repositoryRoot, filePath)) return { supported: false };
  const { repositoryRoot, head } = repositoryInfo;

  const resolvedFilePath = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolvedFilePath);
  } catch {
    // 文件已删除：定向失效对应缓存条目，返回不支持。
    invalidateGitFileDiff(cwd, filePath);
    return { supported: false };
  }
  if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { supported: false };

  // 响应缓存：文件 (mtimeMs, size) 与仓库 HEAD 均未变时直接复用上次 patch，
  // 零 diff/status git 调用（HEAD 已随 toplevel 同一次 rev-parse 取得）。
  // mtime/size 变化即该文件 diff 定向失效——单文件修改只重抓对应 diff；
  // HEAD 变化（分支切换 / reset / checkout）即便工作树文件未变也整体失效
  // ——diff 基线是 HEAD，基线变了缓存即过期（P1-6）。
  const cacheKey = buildDiffCacheKey(cwd, filePath);
  const cached = gitDiffCache.get(cacheKey);
  if (
    !options.force &&
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    cached.head === head
  ) {
    return cached.response;
  }

  const relativePath = toGitPath(path.relative(repositoryRoot, resolvedFilePath));
  const entries = await readStatusEntries(repositoryRoot);
  const entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) {
    invalidateGitFileDiff(cwd, filePath);
    return { supported: false };
  }

  const { status } = classifyGitStatus(entry);
  if (status === "deleted") {
    invalidateGitFileDiff(cwd, filePath);
    return { supported: false };
  }

  const currentBuffer = fs.readFileSync(resolvedFilePath);
  if (hasNullByte(currentBuffer)) return { supported: false };
  const newContent = currentBuffer.toString("utf8");

  let patch: string;
  if (status === "untracked") {
    patch = createAddedFilePatch(relativePath, newContent);
  } else {
    const trackedPatch = await createTrackedFilePatch(repositoryRoot, relativePath, entry.originalPath);
    if (trackedPatch === null) {
      if (status !== "added") return { supported: false };
      patch = createAddedFilePatch(relativePath, newContent);
    } else {
      patch = trackedPatch;
    }
  }

  const response: GitFileDiffResponse = patch.includes("\n@@ ")
    ? { supported: true, status, patch }
    : { supported: false };
  gitDiffCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, head, response });
  return response;
}
