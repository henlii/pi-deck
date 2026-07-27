/**
 * 项目信任的纯决策模型（无 fs / 无 SDK 依赖，可被服务端与浏览器共用）。
 *
 * 镜像 Pi 0.81.1 `core/project-trust.ts` 的 `resolveProjectTrusted` 判定顺序：
 *   1. CLI override（Deck 无命令行开关，恒不适用）
 *   2. 无「需信任的项目资源」→ 直接信任
 *   3. 扩展 `project_trust` 事件
 *   4. `trust.json` 决策（含最近祖先继承）
 *   5. `defaultProjectTrust`：always → 信任；never → 不信任；ask → 继续
 *   6. 无 UI → 不信任
 *
 * 与 Pi 的两处有意偏差，均记录在此，避免后续误读为 bug：
 * - 第 3 步不可达：`emitProjectTrustEvent` / `resolveProjectTrusted` 未出现在
 *   `@earendil-works/pi-coding-agent` 的 exports 映射中（只有 "." 与 "./rpc-entry"），
 *   深路径 import 会被 ERR_PACKAGE_PATH_NOT_EXPORTED 拒绝。Deck 只能使用公开导出的
 *   `ProjectTrustStore` 与 `hasTrustRequiringProjectResources`，因此扩展无法参与判定。
 * - 第 6 步语义化为 `needsDecision`：Deck 解析信任发生在 AgentSession 创建期间，此时
 *   还没有可同步问答的通道（SSE 尚未建立），等价于 Pi 的 `hasUI === false` → 不信任；
 *   但 Deck 额外把「因未决而降级」标记出来，交给界面在会话之外提问。
 */

export type DefaultProjectTrustSetting = "ask" | "always" | "never";

/** trust.json 中命中的条目；`path` 可能是 cwd 的祖先目录。 */
export interface ProjectTrustEntryInfo {
  path: string;
  decision: boolean;
}

export type ProjectTrustSource =
  /** cwd 下没有需要信任门禁的项目资源，不做限制 */
  | "no-trust-requiring-resources"
  /** trust.json 中该路径本身有决策 */
  | "stored"
  /** trust.json 中祖先目录有决策，向下继承 */
  | "stored-inherited"
  | "default-always"
  | "default-never"
  /** defaultProjectTrust=ask 且无任何记录：本次按不信任运行，等待用户决定 */
  | "undecided";

export interface ProjectTrustStatus {
  cwd: string;
  /** cwd 是否存在受信任门禁保护的项目资源（.pi 配置资源或 .agents/skills） */
  requiresTrust: boolean;
  /** trust.json 的生效决策（含继承），无记录为 null */
  storedDecision: boolean | null;
  /** 决策实际保存在哪个路径，无记录为 null */
  storedPath: string | null;
  /** 决策来自祖先目录而非 cwd 本身 */
  inherited: boolean;
  /** 本次会话的有效信任结果 */
  trusted: boolean;
  /** 需要向用户提问（ask 且无记录，且确有受门禁资源） */
  needsDecision: boolean;
  source: ProjectTrustSource;
  defaultProjectTrust: DefaultProjectTrustSetting;
}

export type ProjectTrustChoice = "trust" | "trust-parent" | "distrust";

/** trust.json 中的一条已保存决策（只读展示用）。 */
export interface ProjectTrustDecisionRecord {
  path: string;
  decision: boolean;
}

export interface ProjectTrustDecisionList {
  decisions: ProjectTrustDecisionRecord[];
  defaultProjectTrust: DefaultProjectTrustSetting;
  /** trust.json 损坏时的说明；此时 decisions 为空但不抛错 */
  error?: string;
}

/** 与 SDK `ProjectTrustUpdate` 同形：decision=null 表示删除该路径的记录。 */
export interface ProjectTrustUpdateInput {
  path: string;
  decision: boolean | null;
}

export function isDefaultProjectTrust(value: unknown): value is DefaultProjectTrustSetting {
  return value === "ask" || value === "always" || value === "never";
}

export function isProjectTrustChoice(value: unknown): value is ProjectTrustChoice {
  return value === "trust" || value === "trust-parent" || value === "distrust";
}

/**
 * 仅用于比较，不做 realpath：统一分隔符并去掉结尾分隔符。
 * 调用方负责传入已 canonicalize 的路径（服务端在 IO 层完成）。
 */
export function normalizeTrustPath(path: string): string {
  const unified = path.replaceAll("\\", "/");
  if (unified.length > 1 && unified.endsWith("/")) return unified.replace(/\/+$/, "") || "/";
  return unified;
}

/**
 * 复刻 Pi 的判定顺序。纯函数：所有 fs 探测结果由调用方以 `requiresTrust` /
 * `entry` 形式传入，便于对每条分支定向断言。
 */
export function decideProjectTrust(input: {
  cwd: string;
  requiresTrust: boolean;
  entry: ProjectTrustEntryInfo | null;
  defaultProjectTrust: DefaultProjectTrustSetting;
}): ProjectTrustStatus {
  const { cwd, requiresTrust, entry, defaultProjectTrust } = input;
  const base = {
    cwd,
    requiresTrust,
    storedDecision: entry ? entry.decision : null,
    storedPath: entry ? entry.path : null,
    inherited: entry ? normalizeTrustPath(entry.path) !== normalizeTrustPath(cwd) : false,
    defaultProjectTrust,
  };

  // 没有受门禁资源时 Pi 直接返回 true，连 trust.json 都不查；此处保留已读到的
  // 记录用于界面展示，但不让它影响结果，避免与 Pi 的运行行为分裂。
  if (!requiresTrust) {
    return { ...base, trusted: true, needsDecision: false, source: "no-trust-requiring-resources" };
  }

  if (entry) {
    return {
      ...base,
      trusted: entry.decision,
      needsDecision: false,
      source: base.inherited ? "stored-inherited" : "stored",
    };
  }

  if (defaultProjectTrust === "always") {
    return { ...base, trusted: true, needsDecision: false, source: "default-always" };
  }
  if (defaultProjectTrust === "never") {
    // Pi 在 never 下不提问，直接不信任。Deck 同样不弹窗，只在徽章上体现。
    return { ...base, trusted: false, needsDecision: false, source: "default-never" };
  }

  return { ...base, trusted: false, needsDecision: true, source: "undecided" };
}

/**
 * 复刻 SDK `getProjectTrustOptions` 的写入语义：
 * - trust：仅记录 cwd = true
 * - trust-parent：记录父目录 = true，并清除 cwd 上的旧记录（避免更具体的记录遮蔽父目录）
 * - distrust：记录 cwd = false
 *
 * 不提供 Pi 的「仅本次会话」选项：Deck 的服务端会话可被多次重连复用，
 * 「本次」没有稳定边界，只保留会持久化的决策。
 */
export function buildProjectTrustUpdates(
  cwd: string,
  parentPath: string | null,
  choice: ProjectTrustChoice,
): ProjectTrustUpdateInput[] {
  if (choice === "trust") return [{ path: cwd, decision: true }];
  if (choice === "distrust") return [{ path: cwd, decision: false }];
  if (!parentPath) throw new Error("trust-parent 需要父目录路径");
  return [
    { path: parentPath, decision: true },
    { path: cwd, decision: null },
  ];
}

export type ProjectTrustBadgeTone = "none" | "trusted" | "untrusted" | "undecided";

/**
 * 徽章只在「信任真正起作用」时出现：没有受门禁资源的项目不加噪。
 * 未决 > 不信任 > 已信任，按需要用户注意的程度排序。
 */
export function getProjectTrustBadgeTone(status: ProjectTrustStatus): ProjectTrustBadgeTone {
  if (!status.requiresTrust) return "none";
  if (status.needsDecision) return "undecided";
  return status.trusted ? "trusted" : "untrusted";
}
