import { NextResponse, type NextRequest } from "next/server";
import { guardRequest, type RequestGuardHeaders } from "@/lib/request-guard";

// 请求安全中间件（对齐上游 pi-web 0.8.6 + P0 fail-closed）：
// 1. Host 白名单（localhost/IP/PI_WEB_HOSTNAME/PI_WEB_ALLOWED_HOSTS）——防 DNS rebinding
// 2. API 请求 CSRF 防护（origin/sec-fetch-site 校验；会话导出 navigate 豁免）
// 3. Basic Auth：设置 PIDANCE_PASSWORD（优先）或兼容旧变量 PI_WEB_PASSWORD 即启用（用户名固定 "pi"）
// 4. 兜底认证：未设置密码时仅放行回环请求；非回环请求一律 401（防误绑 0.0.0.0 匿名调用）
export const runtime = "nodejs";

function toHeaders(req: NextRequest): RequestGuardHeaders {
  return {
    host: req.headers.get("host"),
    origin: req.headers.get("origin"),
    secFetchSite: req.headers.get("sec-fetch-site"),
    secFetchMode: req.headers.get("sec-fetch-mode"),
    secFetchDest: req.headers.get("sec-fetch-dest"),
    secFetchUser: req.headers.get("sec-fetch-user"),
    authorization: req.headers.get("authorization"),
    method: req.method,
    url: req.url,
    pathname: req.nextUrl.pathname,
  };
}

export function middleware(req: NextRequest) {
  const isApi = req.nextUrl.pathname === "/api" || req.nextUrl.pathname.startsWith("/api/");
  const verdict = guardRequest(toHeaders(req), process.env);
  switch (verdict) {
    case "untrusted-host":
      return isApi
        ? NextResponse.json({ error: "Untrusted API request" }, { status: 403 })
        : new NextResponse("Untrusted request", { status: 403 });
    case "csrf":
      return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
    case "auth-required":
      return new NextResponse("Authentication required", {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
          "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
        },
      });
    default:
      return NextResponse.next();
  }
}

export const config = {
  matcher: ["/", "/api/:path*"],
};
