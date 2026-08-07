import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const load = () => jiti.import("./ui-session.ts");

test("JWT 签发与校验：有效 / 过期 / 篡改", async () => {
  const {
    signUiSessionJwt,
    verifyUiSessionJwt,
    UI_SESSION_TTL_MS,
  } = await load();
  const secret = "test-secret-key-32bytes-minimum!!";
  const now = 1_700_000_000_000;
  const token = signUiSessionJwt(secret, UI_SESSION_TTL_MS, now);
  assert.equal(verifyUiSessionJwt(token, secret, now + 1000), true);
  assert.equal(verifyUiSessionJwt(token, secret, now + UI_SESSION_TTL_MS + 1000), false);
  assert.equal(verifyUiSessionJwt(token + "x", secret, now + 1000), false);
  assert.equal(verifyUiSessionJwt(token, "other-secret", now + 1000), false);
});

test("TTL：trustDevice 为 7d，默认 12h", async () => {
  const { resolveSessionTtlMs, UI_SESSION_TTL_MS, UI_TRUSTED_DEVICE_TTL_MS } = await load();
  assert.equal(resolveSessionTtlMs(false), UI_SESSION_TTL_MS);
  assert.equal(resolveSessionTtlMs(true), UI_TRUSTED_DEVICE_TTL_MS);
});

test("Cookie 解析与 Set-Cookie 头", async () => {
  const { parseCookieValue, buildSetCookieHeader, UI_SESSION_COOKIE_NAME } = await load();
  assert.equal(
    parseCookieValue(`a=1; ${UI_SESSION_COOKIE_NAME}=abc%2Edef; b=2`, UI_SESSION_COOKIE_NAME),
    "abc.def",
  );
  const header = buildSetCookieHeader({
    name: UI_SESSION_COOKIE_NAME,
    value: "tok",
    maxAgeSeconds: 3600,
    secure: true,
  });
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Max-Age=3600/);
  assert.match(header, /Secure/);
});

test("密钥落盘与 env 优先", async () => {
  const { getOrCreateJwtSecret } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ui-jwt-"));
  const file = path.join(dir, "secret");
  try {
    const mem = {
      map: new Map(),
      readFileSync(p) { return this.map.get(p); },
      writeFileSync(p, data) { this.map.set(p, data); },
      mkdirSync() {},
      existsSync(p) { return this.map.has(p); },
    };
    const a = getOrCreateJwtSecret({}, file, mem);
    const b = getOrCreateJwtSecret({}, file, mem);
    assert.equal(a, b);
    assert.equal(getOrCreateJwtSecret({ PIDANCE_UI_JWT_SECRET: "from-env" }, file, mem), "from-env");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("登录限流：超限锁定后拒绝", async () => {
  const {
    checkLoginRateLimit,
    recordLoginFailure,
    clearLoginFailures,
    resetLoginRateLimitForTests,
    UI_LOGIN_RATE_MAX,
  } = await load();
  resetLoginRateLimitForTests();
  const key = "ip:1.2.3.4";
  for (let i = 0; i < UI_LOGIN_RATE_MAX; i += 1) recordLoginFailure(key, 1000 + i);
  const blocked = checkLoginRateLimit(key, 1000 + UI_LOGIN_RATE_MAX);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
  clearLoginFailures(key);
  assert.equal(checkLoginRateLimit(key, 2000).allowed, true);
});

test("verifyPassword 恒定时间比较", async () => {
  const { verifyPassword } = await load();
  assert.equal(verifyPassword("secret", "secret"), true);
  assert.equal(verifyPassword("secret", "wrong"), false);
  assert.equal(verifyPassword("", "secret"), false);
});
