import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_SAVE_BYTES = 1024 * 1024;
const PROTECTED = new Set([".git", ".pi", ".next", "node_modules", "dist", "build", "coverage", "__pycache__", ".pytest_cache", ".mypy_cache", ".turbo", ".cache", "target", "vendor"]);
export const SAVE_FSYNC = process.env.SAVE_FSYNC === "true";

export class FileSaveError extends Error {
  readonly code: "bad-request" | "forbidden" | "not-found" | "conflict" | "too-large";
  constructor(code: "bad-request" | "forbidden" | "not-found" | "conflict" | "too-large", message: string) { super(message); this.code = code; }
}

export type SaveFileOptions = { target: string; cwd: string; sourceSessionId?: string; allowedRoots: Set<string>; content: string; baseline: { mtimeMs: number; size: number }; isAllowed?: (target: string, roots: Set<string>) => boolean; getBinaryMime?: (target: string) => string | null };

export function validateSaveName(target: string): string | null {
  const parts = target.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => PROTECTED.has(part) || part.startsWith(".pi-save-"))) return "目标路径包含受保护名称";
  const name = target.split(/[\\/]+/).filter(Boolean).pop() ?? "";
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) return "不允许保存环境文件";
  return null;
}

function isWindowsPath(value: string): boolean { return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//"); }
export function isStrictPathChild(target: string, root: string, windows = isWindowsPath(target) || isWindowsPath(root)): boolean {
  const resolver = windows ? path.win32 : path;
  const t = resolver.resolve(target);
  const r = resolver.resolve(root);
  const comparableTarget = windows ? t.toLowerCase() : t;
  const comparableRoot = windows ? r.toLowerCase() : r;
  return comparableTarget !== comparableRoot && comparableTarget.startsWith(comparableRoot.endsWith(resolver.sep) ? comparableRoot : comparableRoot + resolver.sep);
}

function assertContent(content: string, baseline: { mtimeMs: number; size: number }): Buffer {
  if (!Number.isFinite(baseline?.mtimeMs) || baseline.mtimeMs < 0 || !Number.isFinite(baseline?.size) || baseline.size < 0) throw new FileSaveError("bad-request", "保存请求格式无效");
  for (let i = 0; i < content.length; i += 1) {
    const code = content.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      if (code <= 0xdbff && i + 1 < content.length && content.charCodeAt(i + 1) >= 0xdc00 && content.charCodeAt(i + 1) <= 0xdfff) { i += 1; continue; }
      throw new FileSaveError("bad-request", "内容包含不可逆 UTF-8 字符");
    }
  }
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_SAVE_BYTES) throw new FileSaveError("too-large", "文件超过 1MiB");
  return bytes;
}

function mapFsError(error: unknown, fallback: string): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") throw new FileSaveError("not-found", fallback);
  if (code === "EACCES" || code === "EPERM") throw new FileSaveError("forbidden", "文件访问被拒绝");
  throw error;
}

export function saveFile(options: SaveFileOptions): { path: string; size: number; mtimeMs: number } {
  const { target, cwd, allowedRoots, content, baseline } = options;
  const nameError = validateSaveName(target); if (nameError) throw new FileSaveError("forbidden", nameError);
  const bytes = assertContent(content, baseline);
  const allowed = options.isAllowed ?? ((value, roots) => roots.has(value));
  if (!allowed(target, allowedRoots) || !isStrictPathChild(target, cwd)) throw new FileSaveError("forbidden", "目标不在授权会话目录内");

  let original: fs.Stats;
  try { original = fs.lstatSync(target); } catch (error) { return mapFsError(error, "目标文件不存在"); }
  if (original.isSymbolicLink()) throw new FileSaveError("forbidden", "目标不能是符号链接");
  if (!original.isFile()) throw new FileSaveError("bad-request", "目标不是常规文件");
  if (options.getBinaryMime?.(target)) throw new FileSaveError("bad-request", "不允许保存已知二进制文件");

  let realCwd: string; let realTarget: string; let realRoots: Set<string>;
  try {
    realCwd = fs.realpathSync(cwd);
    realTarget = fs.realpathSync(target);
    realRoots = new Set([...allowedRoots].map((root) => fs.realpathSync(root)));
    if (validateSaveName(realTarget) || !allowed(realTarget, realRoots) || !isStrictPathChild(realTarget, realCwd)) throw new FileSaveError("forbidden", "目标不在授权会话目录内");
    for (let current = path.dirname(target); isStrictPathChild(current, cwd); current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new FileSaveError("forbidden", "目标父目录不能是符号链接");
    }
  } catch (error) {
    if (error instanceof FileSaveError) throw error;
    return mapFsError(error, "目标路径不存在");
  }

  let current: fs.Stats;
  try { current = fs.statSync(realTarget); } catch (error) { return mapFsError(error, "目标文件不存在"); }
  if (current.mtimeMs !== baseline.mtimeMs || current.size !== baseline.size) throw new FileSaveError("conflict", JSON.stringify({ mtimeMs: current.mtimeMs, size: current.size }));

  const physicalDirectory = path.dirname(realTarget);
  const temp = path.join(physicalDirectory, `.pi-save-${process.pid}-${randomUUID()}`);
  try {
    fs.writeFileSync(temp, bytes, { flag: "wx", mode: original.mode & 0o7777 });
    fs.chmodSync(temp, original.mode & 0o7777);
    if (SAVE_FSYNC) { const fd = fs.openSync(temp, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    fs.renameSync(temp, realTarget);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* 清理失败不覆盖原错误 */ }
    return mapFsError(error, "保存目标不存在");
  }
  const saved = fs.statSync(realTarget);
  return { path: target, size: saved.size, mtimeMs: saved.mtimeMs };
}
