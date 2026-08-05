import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	hostnameFromHostHeader,
	isTrustedHost,
	checkCsrf,
	checkBasicAuth,
	passwordEnabled,
	isLoopbackHost,
	resolvePassword,
	guardRequest,
} = await jiti.import("../lib/request-guard.ts");

const EMPTY_ENV = {};

function h(over = {}) {
	return {
		host: "127.0.0.1:31415",
		origin: null,
		secFetchSite: null,
		secFetchMode: null,
		secFetchDest: null,
		secFetchUser: null,
		authorization: null,
		method: "GET",
		url: "http://127.0.0.1:31415/api/sessions",
		pathname: "/api/sessions",
		...over,
	};
}

test("hostnameFromHostHeader 提取 hostname", () => {
	assert.equal(hostnameFromHostHeader("127.0.0.1:31415"), "127.0.0.1");
	assert.equal(hostnameFromHostHeader("localhost"), "localhost");
	assert.equal(hostnameFromHostHeader("[::1]:31415"), "::1");
	assert.equal(hostnameFromHostHeader("user:pass@evil.com"), null);
	assert.equal(hostnameFromHostHeader(""), null);
});

test("isTrustedHost：localhost/IP 放行，未知域名拒绝，白名单放行", () => {
	assert.equal(isTrustedHost("localhost:31415", EMPTY_ENV), true);
	assert.equal(isTrustedHost("127.0.0.1:31415", EMPTY_ENV), true);
	assert.equal(isTrustedHost("[::1]", EMPTY_ENV), true);
	assert.equal(isTrustedHost("evil.example.com", EMPTY_ENV), false);
	assert.equal(isTrustedHost("pidance.example.com", { PI_WEB_HOSTNAME: "pidance.example.com" }), true);
	assert.equal(isTrustedHost("a.example.com", { PI_WEB_ALLOWED_HOSTS: " a.example.com, b.example.com " }), true);
	assert.equal(isTrustedHost("c.example.com", { PI_WEB_ALLOWED_HOSTS: "a.example.com" }), false);
	assert.equal(isTrustedHost(null, EMPTY_ENV), false);
});

test("checkCsrf：无跨站信号放行；cross-site 拒绝；origin 同源校验", () => {
	assert.equal(checkCsrf(h()), true); // curl 无头
	assert.equal(checkCsrf(h({ secFetchSite: "same-origin", origin: "http://127.0.0.1:31415" })), true);
	assert.equal(checkCsrf(h({ secFetchSite: "cross-site" })), false);
	assert.equal(checkCsrf(h({ origin: "http://evil.com", secFetchSite: "same-site" })), false);
	assert.equal(checkCsrf(h({ origin: "http://127.0.0.1:31416", secFetchSite: "same-origin" })), false); // 端口不同
	// export navigate 豁免
	const exportReq = h({
		pathname: "/api/sessions/abc123/export",
		url: "http://127.0.0.1:31415/api/sessions/abc123/export",
		method: "GET",
		secFetchMode: "navigate",
		secFetchDest: "document",
		secFetchUser: "?1",
		secFetchSite: "cross-site",
		origin: "http://other.example.com",
	});
	assert.equal(checkCsrf(exportReq), true);
});

test("passwordEnabled / checkBasicAuth：PI_WEB_PASSWORD 可选 Basic Auth", () => {
	assert.equal(passwordEnabled({}), false);
	assert.equal(passwordEnabled({ PI_WEB_PASSWORD: "" }), false);
	assert.equal(passwordEnabled({ PI_WEB_PASSWORD: "s3cret" }), true);

	const env = { PI_WEB_PASSWORD: "s3cret" };
	// 未启用时不拦
	assert.equal(checkBasicAuth(h(), {}), false);
	// 启用后无 Authorization → false
	assert.equal(checkBasicAuth(h(), env), false);
	// 正确凭据 pi:s3cret
	const ok = Buffer.from("pi:s3cret").toString("base64");
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${ok}` }), env), true);
	// 错误密码 / 错误用户 / 非 Basic
	const bad = Buffer.from("pi:wrong").toString("base64");
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${bad}` }), env), false);
	const badUser = Buffer.from("root:s3cret").toString("base64");
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${badUser}` }), env), false);
	assert.equal(checkBasicAuth(h({ authorization: "Bearer xyz" }), env), false);
	// 非法 base64
	assert.equal(checkBasicAuth(h({ authorization: "Basic !!!" }), env), false);
});

test("isLoopbackHost：localhost / 127.x / ::1 放行，其它拒绝", () => {
	assert.equal(isLoopbackHost("127.0.0.1:31415"), true);
	assert.equal(isLoopbackHost("127.8.9.10:31415"), true);
	assert.equal(isLoopbackHost("localhost:31415"), true);
	assert.equal(isLoopbackHost("api.localhost:31415"), true);
	assert.equal(isLoopbackHost("[::1]:31415"), true);
	assert.equal(isLoopbackHost("[0:0:0:0:0:0:0:1]:31415"), true);
	assert.equal(isLoopbackHost("192.168.1.5:31415"), false);
	assert.equal(isLoopbackHost("10.0.0.1"), false);
	assert.equal(isLoopbackHost("myhost:31415"), false);
	assert.equal(isLoopbackHost("fe80::1"), false);
	assert.equal(isLoopbackHost(null), false);
	assert.equal(isLoopbackHost(""), false);
});

test("resolvePassword / passwordEnabled：PIDANCE_PASSWORD 优先，兼容 PI_WEB_PASSWORD", () => {
	assert.equal(passwordEnabled({}), false);
	assert.equal(passwordEnabled({ PI_WEB_PASSWORD: "" }), false);
	assert.equal(passwordEnabled({ PIDANCE_PASSWORD: "s3cret" }), true);
	assert.equal(passwordEnabled({ PI_WEB_PASSWORD: "s3cret" }), true);
	assert.equal(passwordEnabled({ PIDANCE_PASSWORD: "", PI_WEB_PASSWORD: "s3cret" }), true);
	assert.equal(resolvePassword({ PIDANCE_PASSWORD: "a", PI_WEB_PASSWORD: "b" }), "a");
	assert.equal(resolvePassword({ PI_WEB_PASSWORD: "b" }), "b");
	assert.equal(resolvePassword({}), null);
	// 新变量优先：旧值不生效
	const envNew = { PIDANCE_PASSWORD: "new", PI_WEB_PASSWORD: "old" };
	const okNew = Buffer.from("pi:new").toString("base64");
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${okNew}` }), envNew), true);
	const okOld = Buffer.from("pi:old").toString("base64");
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${okOld}` }), envNew), false);
});

test("guardRequest：无密码时非回环请求 auth-required（fail-closed 兜底）", () => {
	// 回环 + 无密码 → ok（本地开发便利）
	assert.equal(guardRequest(h({ host: "127.0.0.1:31415" }), EMPTY_ENV), "ok");
	assert.equal(guardRequest(h({ host: "localhost:31415" }), EMPTY_ENV), "ok");
	// 非回环 + 无密码 → auth-required（兜底；即使 CLI 门禁被绕过也保护）
	assert.equal(guardRequest(h({ host: "192.168.1.5:31415" }), EMPTY_ENV), "auth-required");
	assert.equal(guardRequest(h({ host: "10.0.0.7:31415" }), EMPTY_ENV), "auth-required");
	// 非回环 + 已设密码 → 未认证 auth-required，认证 ok
	const env = { PI_WEB_PASSWORD: "pw" };
	assert.equal(guardRequest(h({ host: "192.168.1.5:31415" }), env), "auth-required");
	const ok = Buffer.from("pi:pw").toString("base64");
	assert.equal(
		guardRequest(h({ host: "192.168.1.5:31415", authorization: `Basic ${ok}` }), env),
		"ok",
	);
	// 回环 + 已设密码 + 未认证 → auth-required（原语义保持）
	assert.equal(guardRequest(h({ host: "127.0.0.1:31415" }), env), "auth-required");
	// 未设置密码且 Host 为未知域名 → 仍是 untrusted-host（Host 白名单优先）
	assert.equal(guardRequest(h({ host: "evil.example.com" }), EMPTY_ENV), "untrusted-host");
});

test("guardRequest 完整判定", () => {
	assert.equal(guardRequest(h(), EMPTY_ENV), "ok");
	assert.equal(guardRequest(h({ host: "evil.com" }), EMPTY_ENV), "untrusted-host");
	assert.equal(guardRequest(h({ secFetchSite: "cross-site" }), EMPTY_ENV), "csrf");
	const env = { PI_WEB_PASSWORD: "pw" };
	assert.equal(guardRequest(h(), env), "auth-required");
	const ok = Buffer.from("pi:pw").toString("base64");
	assert.equal(guardRequest(h({ authorization: `Basic ${ok}` }), env), "ok");
});
