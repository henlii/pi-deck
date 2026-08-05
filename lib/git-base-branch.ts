import { execFile } from "child_process";
import { promisify } from "util";

// ============================================================================
// Git base branch 解析（P1-4，评估文档 c9ab916c）
//
// 单一 Git 层解析函数：从仓库实际引用解析默认分支，不猜 main/master 名称。
// 候选顺序：
//   1. 当前仓库对应 remote 的 symbolic HEAD（refs/remotes/<remote>/HEAD，offline 可用）
//   2. git ls-remote --symref <remote> HEAD（需网络）
//   3. git remote show <remote> 的 HEAD branch（需网络）
//   4. 本地可解析的 main
//   5. 本地可解析的 master
//   6. 无可靠结果返回 branch: null（不伪造分支）
//
// 多 remote 选择：优先当前分支的 upstream remote（branch.<name>.remote），
// 其次 origin，最后 remote 列表的第一个。不硬编码 origin。
// worktree 与主仓共享 refs/remotes（同一 git common dir），解析结果天然一致。
// 消费方职责：base branch === 当前分支时不做「自身 diff」（见 currentBranch 字段）。
// ============================================================================

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 1024 * 1024;

export type BaseBranchSource =
  | "remote-symref-head" // 本地 remote-tracking HEAD（offline 可用）
  | "ls-remote-symref"   // git ls-remote --symref（需网络）
  | "remote-show"        // git remote show（需网络）
  | "local-main"
  | "local-master"
  | null;

export interface BaseBranchInfo {
  /** 解析到的默认分支名（如 "main"）；无可靠结果时为 null */
  branch: string | null;
  /** 解析依据（诊断/测试用） */
  source: BaseBranchSource;
  /** 当前分支（detached HEAD / 非 git 目录时为 null）。
   *  消费方应检查 branch !== currentBranch 再做「diff vs base」，避免自身 diff。 */
  currentBranch: string | null;
}

export interface GitBaseBranchOptions {
  /** git 命令执行注入（默认 execFile("git", ["-C", cwd, ...])）；测试传 fake runner */
  runGit?: (cwd: string, args: string[]) => Promise<string>;
  /** 是否允许网络命令（ls-remote / remote show）。offline 场景传 false。 */
  allowNetwork?: boolean;
  /** 显式指定 remote（多 remote 时优先）；缺省按当前分支 upstream → origin → 第一个 */
  remote?: string;
}

export type GitRunner = NonNullable<GitBaseBranchOptions["runGit"]>;

function defaultRunGit(cwd: string, args: string[]): Promise<string> {
  return execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, LC_ALL: "C" },
  }).then(({ stdout }) => stdout);
}

// ----------------------------------------------------------------------------
// 纯解析函数（无 IO，可直接单测）
// ----------------------------------------------------------------------------

/**
 * 解析 `git symbolic-ref refs/remotes/<remote>/HEAD` 的输出。
 * 输出形如 `refs/remotes/origin/main` → 返回 `main`。
 * 精确剥离 `refs/remotes/<remote>/` 前缀：
 *   - `refs/remotes/origin/feature/main` → `feature/main`（不会被误判为 `main`）；
 *   - 前缀不匹配、detached（输出裸 `HEAD`）或为空 → null。
 */
export function parseSymbolicRemoteHead(output: string, remote: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const prefix = `refs/remotes/${remote}/`;
  if (!trimmed.startsWith(prefix)) return null;
  const branch = trimmed.slice(prefix.length).trim();
  return branch && branch !== "HEAD" ? branch : null;
}

/**
 * 解析 `git ls-remote --symref <remote> HEAD` 输出中的远程 symbolic HEAD 行。
 * 匹配形如 `ref: refs/heads/main HEAD` 的行 → `main`。
 * 只匹配 `refs/heads/<name>` 形态（精确前缀，`refs/heads/feature/main` 完整保留）。
 */
export function parseLsRemoteSymrefHead(output: string): string | null {
  for (const line of output.split("\n")) {
    const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD\s*$/.exec(line.trim());
    if (match) return match[1];
  }
  return null;
}

/**
 * 解析 `git remote show <remote>` 输出中的 HEAD 分支行。
 * 匹配 `HEAD branch: main`（可能带 `(remote)` 标记）→ `main`。
 */
export function parseRemoteShowHeadBranch(output: string): string | null {
  for (const line of output.split("\n")) {
    const match = /^HEAD branch:\s+(?:\(.*\)\s+)?(.+?)\s*$/.exec(line.trim());
    if (match) {
      const branch = match[1].trim();
      // git remote show 无默认分支时输出 (unknown)，不视为有效分支。
      if (branch && branch !== "(unknown)") return branch;
      return null;
    }
  }
  return null;
}

/** 判断本地 refs/heads/<name> 是否可解析（git rev-parse --verify --quiet 成功）。 */
export async function isLocalBranchResolvable(runGit: GitRunner, cwd: string, name: string): Promise<boolean> {
  try {
    await runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** 解析当前分支（`git rev-parse --abbrev-ref HEAD`）；detached（输出 HEAD）→ null。 */
export async function resolveCurrentBranch(runGit: GitRunner, cwd: string): Promise<string | null> {
  try {
    const ref = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return ref && ref !== "HEAD" ? ref : null;
  } catch {
    return null;
  }
}

/** 列出 remote 名（`git remote`），空 → []。 */
export async function listRemotes(runGit: GitRunner, cwd: string): Promise<string[]> {
  try {
    const out = (await runGit(cwd, ["remote"])).trim();
    return out ? out.split("\n").map((r) => r.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 解析当前分支的 upstream remote（`git config --get branch.<name>.remote`）。 */
export async function resolveUpstreamRemote(runGit: GitRunner, cwd: string, branch: string | null): Promise<string | null> {
  if (!branch) return null;
  try {
    const remote = (await runGit(cwd, ["config", "--get", `branch.${branch}.remote`])).trim();
    return remote || null;
  } catch {
    return null;
  }
}

/**
 * 选择解析用的 remote（多 remote 场景）：
 *   显式 remote > 当前分支 upstream > origin（存在时）> 第一个 remote > null。
 */
export function pickRemote(remotes: readonly string[], upstream: string | null, explicit?: string): string | null {
  if (explicit) return explicit;
  if (upstream && remotes.includes(upstream)) return upstream;
  if (remotes.includes("origin")) return "origin";
  return remotes[0] ?? null;
}

// ----------------------------------------------------------------------------
// 主流程
// ----------------------------------------------------------------------------

/**
 * 解析仓库默认（base）分支。
 * 无可靠结果时返回 { branch: null, source: null, currentBranch }，不伪造分支。
 * 非 git 目录（rev-parse 失败）直接返回全空结构。
 */
export async function resolveBaseBranch(cwd: string, options: GitBaseBranchOptions = {}): Promise<BaseBranchInfo> {
  const runGit = options.runGit ?? defaultRunGit;
  const allowNetwork = options.allowNetwork ?? true;
  const empty: BaseBranchInfo = { branch: null, source: null, currentBranch: null };

  // 先确认是 git 仓库并取当前分支（失败即非 git 目录）。
  let currentBranch: string | null;
  try {
    currentBranch = await resolveCurrentBranch(runGit, cwd);
  } catch {
    return empty;
  }
  if (currentBranch === undefined) return empty;

  // remote 选择。
  const remotes = await listRemotes(runGit, cwd);
  const upstream = await resolveUpstreamRemote(runGit, cwd, currentBranch);
  const remote = pickRemote(remotes, upstream, options.remote);

  // 候选 1：本地 remote-tracking HEAD（offline 可用，最高优先）。
  if (remote) {
    try {
      const out = await runGit(cwd, ["symbolic-ref", `refs/remotes/${remote}/HEAD`]);
      const branch = parseSymbolicRemoteHead(out, remote);
      if (branch) return { branch, source: "remote-symref-head", currentBranch };
    } catch {
      // ref 不存在或未设置，继续下一候选。
    }
  }

  // 候选 2/3：网络命令（offline 或失败时跳过）。
  if (allowNetwork && remote) {
    try {
      const lsRemote = await runGit(cwd, ["ls-remote", "--symref", remote, "HEAD"]);
      const branch = parseLsRemoteSymrefHead(lsRemote);
      if (branch) return { branch, source: "ls-remote-symref", currentBranch };
    } catch {
      // offline / 无权限，继续下一候选。
    }
    try {
      const show = await runGit(cwd, ["remote", "show", remote]);
      const branch = parseRemoteShowHeadBranch(show);
      if (branch) return { branch, source: "remote-show", currentBranch };
    } catch {
      // 继续下一候选。
    }
  }

  // 候选 4/5：本地可解析的 main / master。
  if (await isLocalBranchResolvable(runGit, cwd, "main")) {
    return { branch: "main", source: "local-main", currentBranch };
  }
  if (await isLocalBranchResolvable(runGit, cwd, "master")) {
    return { branch: "master", source: "local-master", currentBranch };
  }

  // 候选 6：无可靠结果。
  return { branch: null, source: null, currentBranch };
}
