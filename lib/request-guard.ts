/**
 * 请求安全守卫（对齐上游 pi-web 0.8.6 middleware）：
 * - Host 白名单：仅 localhost / *.localhost / IP / PI_WEB_HOSTNAME / PI_WEB_ALLOWED_HOSTS
 *   （防 DNS rebinding）
 * - CSRF：API 请求校验 origin/sec-fetch-site（cross-site 拒绝、origin 须与 Host 同源；
 *   会话导出的 navigate GET 豁免；无跨站信号的非浏览器客户端放行）
 * - 可选 Basic Auth：设置 PI_WEB_PASSWORD 即启用（用户名固定 "pi"，timingSafeEqual 比较）
 * 纯逻辑（env 注入），供 middleware.ts 组装与 .test.mjs 测试。
 */
import { createHash, timingSafeEqual } from "crypto";
import { isIP } from "net";

export const EXPORT_NAVIGATE_RE = /^\/api\/sessions\/[^/]+\/export$/;

export type RequestGuardHeaders = {
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  secFetchMode: string | null;
  secFetchDest: string | null;
  secFetchUser: string | null;
  authorization: string | null;
  method: string;
  url: string;
  pathname: string;
};

/** 对齐上游：IPv6 去括号、小写、去尾点。 */
function normalizeHostname(hostname: string): string {
  return (hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname)
    .toLowerCase()
    .replace(/\.$/, "");
}

export function hostnameFromHostHeader(host: string): string | null {
  if (!host || /[\s/@\\]/.test(host)) return null;
  try {
    const url = new URL(`http://${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return normalizeHostname(url.hostname);
  } catch {
    return null;
  }
}

export function allowedHosts(env: Record<string, string | undefined>): string[] {
  return [
    env.PI_WEB_HOSTNAME,
    ...(env.PI_WEB_ALLOWED_HOSTS?.split(",") ?? []),
  ]
    .filter((h): h is string => typeof h === "string" && h.trim().length > 0)
    .map((h) => h.trim());
}

/** Host 白名单校验（DNS rebinding 防护）。 */
export function isTrustedHost(hostHeader: string | null, env: Record<string, string | undefined>): boolean {
  const hostname = hostHeader ? hostnameFromHostHeader(hostHeader) : null;
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isIP(hostname) !== 0) return true;
  const names = allowedHosts(env).map((h) => hostnameFromHostHeader(h)).filter((n): n is string => n !== null);
  return names.includes(hostname);
}

function isExportNavigate(req: RequestGuardHeaders): boolean {
  if (req.method !== "GET") return false;
  if (req.secFetchMode !== "navigate") return false;
  if (req.secFetchDest !== "document") return false;
  if (req.secFetchUser !== "?1") return false;
  return EXPORT_NAVIGATE_RE.test(req.pathname);
}

/** origin 与 Host 是否同源。 */
export function isSameOrigin(req: RequestGuardHeaders): boolean {
  if (!req.origin || !req.host) return false;
  try {
    const base = new URL(req.url);
    return new URL(req.origin).origin === new URL(`${base.protocol}//${req.host}`).origin;
  } catch {
    return false;
  }
}

/** CSRF 防护：无跨站信号放行；cross-site 拒绝；origin 存在则须同源。 */
export function checkCsrf(req: RequestGuardHeaders): boolean {
  if (isExportNavigate(req)) return true;
  const hasCrossSiteSignal = req.origin !== null || req.secFetchSite !== null;
  if (!hasCrossSiteSignal) return true;
  if (req.secFetchSite === "cross-site") return false;
  if (!req.origin) return true;
  return isSameOrigin(req);
}

export function passwordEnabled(env: Record<string, string | undefined>): boolean {
  const p = env.PI_WEB_PASSWORD;
  return typeof p === "string" && p.length > 0;
}

function sha256(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** Basic Auth 校验：Authorization: Basic base64("pi:<password>")。 */
export function checkBasicAuth(req: RequestGuardHeaders, env: Record<string, string | undefined>): boolean {
  const password = env.PI_WEB_PASSWORD;
  if (!passwordEnabled(env) || !password) return false;
  const auth = req.authorization;
  if (!auth) return false;
  const match = /^Basic\s+(\S+)$/i.exec(auth);
  if (!match) return false;
  let decoded: string;
  try {
    const buf = Buffer.from(match[1], "base64");
    if (buf.toString("base64") !== match[1]) return false;
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx === -1) return false;
  return safeEqual(decoded.slice(0, idx), "pi") && safeEqual(decoded.slice(idx + 1), password);
}

export type GuardVerdict = "ok" | "untrusted-host" | "csrf" | "auth-required";

/** 完整判定（middleware 用；isApi 区分错误形态）。 */
export function guardRequest(req: RequestGuardHeaders, env: Record<string, string | undefined>): GuardVerdict {
  if (!isTrustedHost(req.host, env)) return "untrusted-host";
  if (req.pathname === "/api" || req.pathname.startsWith("/api/")) {
    if (!checkCsrf(req)) return "csrf";
  }
  if (passwordEnabled(env) && !checkBasicAuth(req, env)) return "auth-required";
  return "ok";
}
