/**
 * Skills PATCH 写边界（#16 D1 / #17 D1）。
 *
 * 旧实现直接信任客户端 filePath（只查 existsSync 就 readFileSync/writeFileSync），
 * 被授权用户可借 PATCH /api/skills 改写任意存在文件。本模块把写操作收敛为：
 *
 * 1. loader 权威列表校验 —— filePath 必须精确命中 `loadSkillsWithInstallInfo(cwd)`
 *    返回的技能，客户端不能自指路径；
 * 2. 来源可写性 —— 全局技能（agentDir/skills、~/.agents/skills）可写；项目技能
 *    （cwd/.pi/skills、cwd/.agents/skills）需要项目信任；其余（package/temporary）
 *    拒绝；
 * 3. symlink 拒绝 + realpath 一致性 —— 写前 lstat 必须是常规文件；
 * 4. 同目录临时文件原子替换 + 权限保持；
 * 5. 行尾保持 —— 按原文件 CRLF/LF 插入或删除键，不混入固定 LF。
 */

import { lstatSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadSkillsWithInstallInfo } from "./skills-service";
import { isUsableProjectPath, resolveProjectTrustedForSession } from "./project-trust";
import type { SkillInfo } from "./api-types";

export class SkillWriteError extends Error {
  readonly code: "bad-request" | "not-found" | "forbidden";
  constructor(code: "bad-request" | "not-found" | "forbidden", message: string) {
    super(message);
    this.code = code;
  }
}

const KEY = "disable-model-invocation";

interface SkillWriteDeps {
  loadSkills: (cwd: string) => Promise<{ skills: SkillInfo[] }>;
  resolveProjectTrusted: (cwd: string) => boolean;
  agentDir: string;
  homeDir: string;
}

const defaultDeps: SkillWriteDeps = {
  loadSkills: (cwd) => loadSkillsWithInstallInfo(cwd),
  resolveProjectTrusted: (cwd) => resolveProjectTrustedForSession(cwd),
  agentDir: getAgentDir(),
  homeDir: homedir(),
};

/** 规范化后是否在某个根之内（含根本身）。 */
function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * 技能来源可写性判定（路径级，与 loader sourceInfo 互补）：
 * - 全局技能根（agentDir/skills、~/.agents/skills）：用户自己的配置，可写；
 * - 项目技能根（cwd/.pi/skills、cwd/.agents/skills）：写项目文件，需项目信任；
 * - 其余（node_modules 包技能、temporary、<inline> 等）：不可写。
 */
function classifySkillSource(filePath: string, cwd: string, deps: SkillWriteDeps): "global" | "project" | "denied" {
  const globalRoots = [join(deps.agentDir, "skills"), join(deps.homeDir, ".agents", "skills")];
  if (globalRoots.some((root) => isWithin(filePath, root))) return "global";
  const projectRoots = [join(cwd, ".pi", "skills"), join(cwd, ".agents", "skills")];
  if (projectRoots.some((root) => isWithin(filePath, root))) return "project";
  return "denied";
}

/** 检测文件换行风格：首个换行前是否 \r。 */
function detectNewline(content: string): "\r\n" | "\n" {
  const first = content.indexOf("\n");
  if (first > 0 && content.charCodeAt(first - 1) === 13) return "\r\n";
  return "\n";
}

/** 在保留原 frontmatter 行尾的前提下做外科手术式编辑。 */
function editFrontmatterKey(content: string, disable: boolean): string {
  const nl = detectNewline(content);
  const alreadySet = new RegExp(`^${KEY}\\s*:`, "m").test(content);
  if (disable && !alreadySet) {
    // 在开头的 --- 行后插入；无 frontmatter 则新建一段。
    const withFm = content.replace(/^---(?:\r?\n)/, `---${nl}${KEY}: true${nl}`);
    if (withFm !== content) return withFm;
    return `---${nl}${KEY}: true${nl}---${nl}${content}`;
  }
  if (!disable && alreadySet) {
    return content.replace(new RegExp(`^${KEY}\\s*:.*(?:\r?\n)`, "m"), "");
  }
  return content;
}

export interface ToggleSkillInput {
  cwd: string;
  filePath: string;
  disableModelInvocation: boolean;
}

export async function toggleSkillDisableModelInvocation(
  input: ToggleSkillInput,
  deps: SkillWriteDeps = defaultDeps,
): Promise<{ success: true }> {
  const { cwd, filePath, disableModelInvocation } = input;
  if (!cwd || typeof cwd !== "string") throw new SkillWriteError("bad-request", "cwd required");
  if (!filePath || typeof filePath !== "string") throw new SkillWriteError("bad-request", "filePath required");
  if (typeof disableModelInvocation !== "boolean") throw new SkillWriteError("bad-request", "disableModelInvocation must be boolean");
  if (!isAbsolute(filePath)) throw new SkillWriteError("bad-request", "filePath must be absolute");
  if (!isUsableProjectPath(cwd)) throw new SkillWriteError("bad-request", "cwd must be an existing directory");

  // 1. loader 权威列表校验：filePath 必须精确命中当前 cwd 加载的技能。
  const { skills } = await deps.loadSkills(cwd);
  const match = skills.find((skill) => resolve(skill.filePath) === resolve(filePath));
  if (!match) throw new SkillWriteError("not-found", "skill not in loader list for cwd");

  // 2. 来源可写性 + 项目信任门禁。
  const source = classifySkillSource(filePath, cwd, deps);
  if (source === "denied") throw new SkillWriteError("forbidden", "skill source is not writable (package/temporary)");
  if (source === "project" && !deps.resolveProjectTrusted(cwd)) {
    throw new SkillWriteError("forbidden", "project is not trusted");
  }

  // 3. symlink 拒绝 + 常规文件检查。
  let stat: ReturnType<typeof statSync>;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new SkillWriteError("not-found", "file not found");
  }
  if (stat.isSymbolicLink()) throw new SkillWriteError("forbidden", "target must not be a symbolic link");
  if (!stat.isFile()) throw new SkillWriteError("bad-request", "target is not a regular file");

  // 4. 读原内容，保持行尾做外科手术式编辑。
  const content = readFileSync(filePath, "utf8");
  const updated = editFrontmatterKey(content, disableModelInvocation);

  // 5. 同目录临时文件原子替换 + 权限保持。
  const physicalDir = dirname(filePath);
  const temp = join(physicalDir, `.pi-skill-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temp, updated, { flag: "wx", mode: stat.mode & 0o7777 });
    renameSync(temp, filePath);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* 清理失败不覆盖原错误 */ }
    if ((error as NodeJS.ErrnoException)?.code === "EACCES" || (error as NodeJS.ErrnoException)?.code === "EPERM") {
      throw new SkillWriteError("forbidden", "file write denied");
    }
    throw error;
  }
  return { success: true };
}
