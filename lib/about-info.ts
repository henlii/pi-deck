/**
 * 从 package.json 形状构造 About 只读信息（纯函数，无 IO）。
 */

export interface AboutInfo {
  name: string;
  version: string;
  piSdkVersion: string | null;
  homepage: string | null;
  repository: string | null;
}

const PI_SDK_DEP = "@earendil-works/pi-coding-agent";
const DEFAULT_NAME = "Pi Deck";

/** 将 package.json 的 repository 字段规范为 https 浏览 URL。 */
export function normalizeRepositoryUrl(repository: unknown): string | null {
  if (typeof repository === "string") {
    return cleanGitUrl(repository);
  }
  if (repository && typeof repository === "object" && "url" in repository) {
    const url = (repository as { url?: unknown }).url;
    if (typeof url === "string") return cleanGitUrl(url);
  }
  return null;
}

function cleanGitUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url = trimmed;
  if (url.startsWith("git+")) url = url.slice(4);
  if (url.startsWith("git://")) url = `https://${url.slice("git://".length)}`;
  if (url.endsWith(".git")) url = url.slice(0, -4);
  return url || null;
}

/**
 * 从已解析的 package.json 对象构造 About 载荷。
 * 字段缺失时使用安全默认值，不抛错。
 */
export function buildAboutInfo(pkg: unknown): AboutInfo {
  const record = pkg && typeof pkg === "object" ? (pkg as Record<string, unknown>) : {};
  const name = typeof record.name === "string" && record.name.trim()
    ? (record.name.includes("pi-deck") ? DEFAULT_NAME : record.name.trim())
    : DEFAULT_NAME;
  // 包名 @henlii/pi-deck 对外展示统一为 Pi Deck
  const displayName = record.name === "@henlii/pi-deck" || name.includes("pi-deck")
    ? DEFAULT_NAME
    : name;

  const version = typeof record.version === "string" && record.version.trim()
    ? record.version.trim()
    : "0.0.0";

  const homepage = typeof record.homepage === "string" && record.homepage.trim()
    ? record.homepage.trim()
    : null;

  const repository = normalizeRepositoryUrl(record.repository);

  let piSdkVersion: string | null = null;
  const deps = record.dependencies;
  if (deps && typeof deps === "object") {
    const v = (deps as Record<string, unknown>)[PI_SDK_DEP];
    if (typeof v === "string" && v.trim()) piSdkVersion = v.trim().replace(/^[\^~]/, "");
  }

  return {
    name: displayName,
    version,
    piSdkVersion,
    homepage,
    repository,
  };
}
