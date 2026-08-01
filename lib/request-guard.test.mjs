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

test("guardRequest 完整判定", () => {
	assert.equal(guardRequest(h(), EMPTY_ENV), "ok");
	assert.equal(guardRequest(h({ host: "evil.com" }), EMPTY_ENV), "untrusted-host");
	assert.equal(guardRequest(h({ secFetchSite: "cross-site" }), EMPTY_ENV), "csrf");
	const env = { PI_WEB_PASSWORD: "pw" };
	assert.equal(guardRequest(h(), env), "auth-required");
	const ok = Buffer.from("pi:pw").toString("base64");
	assert.equal(guardRequest(h({ authorization: `Basic ${ok}` }), env), "ok");
});
