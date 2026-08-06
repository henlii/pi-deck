/**
 * Workspace History 只读投影与 shadow git 只读 diff。
 * 从会话 custom entries 折叠 workspace-history.snapshot；
 * 不写 Pi schema / shadow repo，也不把 snapshot 伪装成聊天气泡。
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildActiveBranchPath, type SessionBranchEntry } from "./session-branch-path";

export type WorkspaceSnapshotKind = "baseline" | "before" | "after" | "manual";

export interface WorkspaceHistoryMarker {
  entryId: string;
  kind: WorkspaceSnapshotKind;
  commit: string;
  shortCommit: string;
  label?: string;
  promptText?: string;
  createdAt: string;
  userEntryId?: string;
  beforeSnapshotId?: string;
}

export interface WorkspaceHistoryView {
  hasData: true;
  /** 有界列表（≤ WH_MAX_MARKERS），按 branch path 出现序，较新在末尾 */
  markers: WorkspaceHistoryMarker[];
  counts: {
    total: number;
    byKind: Partial<Record<WorkspaceSnapshotKind, number>>;
  };
}

/** 有界：active path 上有效 snapshot 最多 50 条（保留较新 slice 末尾） */
export const WH_MAX_MARKERS = 50;

export const WORKSPACE_HISTORY_SNAPSHOT = "workspace-history.snapshot";
export const DEFAULT_WORKSPACE_HISTORY_STORAGE_DIR = path.join(
  ".pi",
  "agent",
  "state",
  "workspace-history",
);

const SNAPSHOT_KINDS = ["baseline", "before", "after", "manual"] as const;
const COMMIT_PATTERN = /^[a-f0-9]{7,64}$/i;

const execFileAsync = promisify(execFile);
const GIT_DIFF_TIMEOUT_MS = 10_000;
const GIT_DIFF_MAX_BUFFER = 4 * 1024 * 1024;

export type WorkspaceHistoryEntry = SessionBranchEntry;

type SnapshotData = {
  v: 1;
  kind: WorkspaceSnapshotKind;
  commit: string;
  turnId?: string;
  promptText?: string;
  userEntryId?: string;
  assistantEntryId?: string;
  beforeSnapshotId?: string;
  resultLeafId?: string;
  label?: string;
  createdAt: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSnapshotKind(value: unknown): value is WorkspaceSnapshotKind {
  return typeof value === "string" && (SNAPSHOT_KINDS as readonly string[]).includes(value);
}

function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT_PATTERN.test(value);
}

/** 校验 workspace-history.snapshot 的 data 形状（与 pi-workspace-history@0.2.2 对齐） */
export function isWorkspaceSnapshotData(value: unknown): value is SnapshotData {
  if (!isPlainRecord(value)) return false;
  if (value.v !== 1) return false;
  if (!isSnapshotKind(value.kind)) return false;
  if (!isCommitSha(value.commit)) return false;
  if (!isNonEmptyString(value.createdAt)) return false;
  // 可选字段：有则须为非空字符串
  for (const key of [
    "turnId",
    "promptText",
    "userEntryId",
    "assistantEntryId",
    "beforeSnapshotId",
    "resultLeafId",
    "label",
  ] as const) {
    if (value[key] !== undefined && !isNonEmptyString(value[key])) return false;
  }
  return true;
}

function takeTail<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  return items.slice(items.length - max);
}

function toMarker(entryId: string, data: SnapshotData): WorkspaceHistoryMarker {
  const marker: WorkspaceHistoryMarker = {
    entryId,
    kind: data.kind,
    commit: data.commit,
    shortCommit: data.commit.slice(0, 7),
    createdAt: data.createdAt,
  };
  if (data.label !== undefined) marker.label = data.label;
  if (data.promptText !== undefined) marker.promptText = data.promptText;
  if (data.userEntryId !== undefined) marker.userEntryId = data.userEntryId;
  if (data.beforeSnapshotId !== undefined) marker.beforeSnapshotId = data.beforeSnapshotId;
  return marker;
}

/**
 * 在 active branch path 上收集 workspace-history.snapshot，投影为只读视图。
 * 无效 data 跳过；无任何有效 snapshot → null。
 * markers 按 root→leaf 出现序，较新在末尾；超过 WH_MAX_MARKERS 时截断保留末尾。
 */
export function projectWorkspaceHistory(
  entries: ReadonlyArray<WorkspaceHistoryEntry>,
  leafId?: string | null,
): WorkspaceHistoryView | null {
  const pathEntries = buildActiveBranchPath(entries, leafId);
  const markers: WorkspaceHistoryMarker[] = [];

  for (const entry of pathEntries) {
    if (entry.type !== "custom") continue;
    if (entry.customType !== WORKSPACE_HISTORY_SNAPSHOT) continue;
    if (!isWorkspaceSnapshotData(entry.data)) continue;
    markers.push(toMarker(entry.id, entry.data));
  }

  if (markers.length === 0) return null;

  const byKind: Partial<Record<WorkspaceSnapshotKind, number>> = {};
  for (const m of markers) {
    byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
  }

  return {
    hasData: true,
    markers: takeTail(markers, WH_MAX_MARKERS),
    counts: {
      total: markers.length,
      byKind,
    },
  };
}

export interface WorkspaceHistoryStoragePaths {
  storageDir: string;
  workspaceHash: string;
  sessionRoot: string;
  shadowGitDir: string;
  reusableGitDir: string;
}

/**
 * 解析 shadow storage 路径（与插件 buildWorkspaceStoragePaths 对齐）。
 * workspaceHash = sha256(realpath(cwd)).hex.slice(0, 24)；realpath 失败时用 resolve。
 */
export function resolveWorkspaceHistoryStoragePaths(opts: {
  cwd: string;
  sessionId: string;
  storageDir?: string;
  homeDir?: string;
}): WorkspaceHistoryStoragePaths {
  const home = opts.homeDir ?? homedir();
  const storageDir = path.resolve(
    opts.storageDir ?? path.join(home, DEFAULT_WORKSPACE_HISTORY_STORAGE_DIR),
  );

  let cwdReal: string;
  try {
    cwdReal = realpathSync(path.resolve(opts.cwd));
  } catch {
    cwdReal = path.resolve(opts.cwd);
  }
  const workspaceHash = createHash("sha256").update(path.normalize(cwdReal)).digest("hex").slice(0, 24);
  const workspaceRoot = path.join(storageDir, "workspaces", workspaceHash);
  const sessionRoot = path.join(workspaceRoot, "sessions", opts.sessionId);

  return {
    storageDir,
    workspaceHash,
    sessionRoot,
    shadowGitDir: path.join(sessionRoot, "repo.git"),
    reusableGitDir: path.join(workspaceRoot, "repo.git"),
  };
}

/** shadowGitDir realpath 必须落在 storageDir 内（防路径逃逸） */
export function isShadowGitDirWithinStorage(shadowGitDir: string, storageDir: string): boolean {
  let realShadow: string;
  let realStorage: string;
  try {
    realStorage = realpathSync(path.resolve(storageDir));
  } catch {
    realStorage = path.resolve(storageDir);
  }
  try {
    realShadow = realpathSync(path.resolve(shadowGitDir));
  } catch {
    // 目录尚不存在时用 resolve 结果做边界判断
    realShadow = path.resolve(shadowGitDir);
  }
  const relative = path.relative(realStorage, realShadow);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function isSafeCommitRef(value: string): boolean {
  return COMMIT_PATTERN.test(value);
}

/**
 * 只读 name-status diff（shadow git）。
 * 失败降级为 { files: [], error }，不抛出。
 */
export async function listWorkspaceSnapshotDiff(opts: {
  shadowGitDir: string;
  fromCommit: string;
  toCommit: string;
  storageDir: string;
  maxFiles?: number;
}): Promise<{ files: Array<{ status: string; path: string }>; error?: string }> {
  const maxFiles = opts.maxFiles ?? 200;

  if (!isSafeCommitRef(opts.fromCommit) || !isSafeCommitRef(opts.toCommit)) {
    return { files: [], error: "invalid commit ref" };
  }
  if (!isShadowGitDirWithinStorage(opts.shadowGitDir, opts.storageDir)) {
    return { files: [], error: "shadow git dir outside storage bound" };
  }

  try {
    const workTree = tmpdir();
    const { stdout } = await execFileAsync(
      "git",
      [
        `--git-dir=${opts.shadowGitDir}`,
        `--work-tree=${workTree}`,
        "diff",
        "--name-status",
        opts.fromCommit,
        opts.toCommit,
      ],
      {
        timeout: GIT_DIFF_TIMEOUT_MS,
        maxBuffer: GIT_DIFF_MAX_BUFFER,
        env: { ...process.env, LC_ALL: "C" },
      },
    );

    const files: Array<{ status: string; path: string }> = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      // name-status: "M\tpath" 或 rename "R100\told\tnew"
      const parts = line.split("\t");
      if (parts.length < 2) continue;
      const status = parts[0]!.trim();
      const filePath = parts.length >= 3 ? parts[parts.length - 1]! : parts[1]!;
      if (!status || !filePath) continue;
      files.push({ status, path: filePath });
      if (files.length >= maxFiles) break;
    }
    return { files };
  } catch (e) {
    return { files: [], error: String(e instanceof Error ? e.message : e) };
  }
}
