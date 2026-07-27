import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

const {
  canExportSession,
  buildSessionExportHtmlHref,
  buildSessionExportJsonlHref,
} = await jiti.import("./session-export-links.ts");

test("canExportSession: 仅有真实 id 的已持久化会话可导出", () => {
  assert.equal(canExportSession(null), false);
  assert.equal(canExportSession(undefined), false);
  assert.equal(canExportSession({}), false);
  assert.equal(canExportSession({ id: null }), false);
  assert.equal(canExportSession({ id: "" }), false);
  assert.equal(canExportSession({ id: "abc-123" }), true);
});

test("buildSessionExportHtmlHref: 精确路径，默认 attachment（无 inline 参数）", () => {
  assert.equal(buildSessionExportHtmlHref("abc-123"), "/api/sessions/abc-123/export");
  assert.ok(!buildSessionExportHtmlHref("abc-123").includes("inline"));
});

test("buildSessionExportHtmlHref: sessionId 特殊字符被编码", () => {
  assert.equal(buildSessionExportHtmlHref("a/b c"), "/api/sessions/a%2Fb%20c/export");
});

test("buildSessionExportJsonlHref: 有 leaf 时包含 format 与 leafId", () => {
  assert.equal(
    buildSessionExportJsonlHref("abc-123", "leaf42"),
    "/api/sessions/abc-123/export?format=jsonl&leafId=leaf42",
  );
});

test("buildSessionExportJsonlHref: leaf 为空时省略 leafId 参数", () => {
  const base = "/api/sessions/abc-123/export?format=jsonl";
  assert.equal(buildSessionExportJsonlHref("abc-123", null), base);
  assert.equal(buildSessionExportJsonlHref("abc-123", undefined), base);
  assert.equal(buildSessionExportJsonlHref("abc-123", ""), base);
});

test("buildSessionExportJsonlHref: leafId 特殊字符被编码", () => {
  assert.equal(
    buildSessionExportJsonlHref("abc-123", "leaf/x y"),
    "/api/sessions/abc-123/export?format=jsonl&leafId=leaf%2Fx+y",
  );
});
