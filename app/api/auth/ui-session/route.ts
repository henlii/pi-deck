import { NextRequest, NextResponse } from "next/server";
import { resolvePassword, passwordEnabled } from "@/lib/request-guard";
import {
  buildSetCookieHeader,
  checkLoginRateLimit,
  clearLoginFailures,
  clientIpFromHeaders,
  getOrCreateJwtSecret,
  isSecureRequest,
  parseCookieValue,
  recordLoginFailure,
  resolveSessionTtlMs,
  signUiSessionJwt,
  UI_SESSION_COOKIE_NAME,
  verifyPassword,
  verifyUiSessionJwt,
} from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function cookieHeader(req: NextRequest, token: string, maxAgeSeconds: number): string {
  const secure = isSecureRequest(req.url, req.headers.get("x-forwarded-proto"));
  return buildSetCookieHeader({
    name: UI_SESSION_COOKIE_NAME,
    value: encodeURIComponent(token),
    maxAgeSeconds,
    secure,
  });
}

function clearCookieHeader(req: NextRequest): string {
  return cookieHeader(req, "", 0);
}

/** GET：会话状态（未登录 401；未设密码时 authenticated:true, passwordRequired:false）。 */
export async function GET(req: NextRequest) {
  if (!passwordEnabled(process.env)) {
    return NextResponse.json({ authenticated: true, passwordRequired: false });
  }
  const secret = getOrCreateJwtSecret(process.env);
  const token = parseCookieValue(req.headers.get("cookie"), UI_SESSION_COOKIE_NAME);
  if (token && verifyUiSessionJwt(token, secret)) {
    return NextResponse.json({ authenticated: true, passwordRequired: true });
  }
  return NextResponse.json(
    { authenticated: false, passwordRequired: true, locked: true },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

/** POST：登录 { password, trustDevice? }。 */
export async function POST(req: NextRequest) {
  if (!passwordEnabled(process.env)) {
    return NextResponse.json({ authenticated: true, passwordRequired: false });
  }
  const expected = resolvePassword(process.env);
  if (!expected) {
    return NextResponse.json({ error: "Password not configured" }, { status: 500 });
  }

  const ip = clientIpFromHeaders({
    "x-forwarded-for": req.headers.get("x-forwarded-for"),
    "x-real-ip": req.headers.get("x-real-ip"),
  });
  const rateKey = `login:${ip}`;
  const rate = checkLoginRateLimit(rateKey);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts, please try again later", retryAfter: rate.retryAfterSeconds },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSeconds),
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": "0",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const body = await req.json().catch(() => null) as {
    password?: unknown;
    trustDevice?: unknown;
  } | null;
  const candidate = typeof body?.password === "string" ? body.password : "";
  if (!verifyPassword(candidate, expected)) {
    recordLoginFailure(rateKey);
    const res = NextResponse.json(
      { error: "Invalid credentials", authenticated: false },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
    res.headers.set("Set-Cookie", clearCookieHeader(req));
    return res;
  }

  clearLoginFailures(rateKey);
  const trustDevice = body?.trustDevice === true;
  const ttlMs = resolveSessionTtlMs(trustDevice);
  const secret = getOrCreateJwtSecret(process.env);
  const token = signUiSessionJwt(secret, ttlMs);
  const res = NextResponse.json(
    { authenticated: true, passwordRequired: true, trustDevice },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
  res.headers.set("Set-Cookie", cookieHeader(req, token, Math.floor(ttlMs / 1000)));
  return res;
}

/** DELETE：登出，清除 Cookie。 */
export async function DELETE(req: NextRequest) {
  const res = NextResponse.json(
    { authenticated: false, passwordRequired: passwordEnabled(process.env) },
    { headers: { "Cache-Control": "no-store" } },
  );
  res.headers.set("Set-Cookie", clearCookieHeader(req));
  return res;
}
