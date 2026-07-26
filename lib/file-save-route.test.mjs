import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { handleSaveRequest } = await jiti.import("./file-save-route.ts");
const { FileSaveError } = await jiti.import("./file-save.ts");

const request = (body, sessionId = "session-1") => ({
  nextUrl: { searchParams: new URLSearchParams(sessionId === null ? "" : `sessionId=${sessionId}`) },
  json: async () => body,
});

function deps(overrides = {}) {
  const calls = { save: 0, roots: 0 };
  const actual = {
    resolveSessionPath: async () => "/tmp/fake-session.jsonl",
    requireWritableSession: async () => {},
    isReadOnly: async () => false,
    readSessionHeader: () => ({ cwd: "/tmp/fake-cwd" }),
    getAllowedFileRoots: async () => { calls.roots++; return new Set(["/tmp/fake-cwd"]); },
    isFilePathAllowed: (target, roots) => [...roots].some((root) => target === root || target.startsWith(`${root}/`)),
    getBinaryMime: () => null,
    saveFile: (options) => { calls.save++; calls.options = options; return { path: options.target, size: options.content.length, mtimeMs: 42 }; },
    ...overrides,
  };
  return { actual, calls };
}

const validBody = { content: "updated", baseline: { mtimeMs: 10, size: 3 } };
const target = "/tmp/fake-cwd/note.txt";

test("缺失 sessionId、非法 baseline 在任何保存依赖前返回 400", async () => {
  for (const baseline of [
    { mtimeMs: NaN, size: 3 }, { mtimeMs: Infinity, size: 3 },
    { mtimeMs: -1, size: 3 }, { mtimeMs: 10, size: NaN },
    { mtimeMs: 10, size: Infinity }, { mtimeMs: 10, size: -1 },
  ]) {
    const { actual, calls } = deps({ resolveSessionPath: async () => { throw new Error("不应解析 session"); } });
    const response = await handleSaveRequest(request({ content: "x", baseline }), target, actual);
    assert.equal(response.status, 400); assert.equal(calls.save, 0);
  }
  const { actual } = deps({ resolveSessionPath: async () => { throw new Error("不应解析 session"); } });
  assert.equal((await handleSaveRequest(request(validBody, null), target, actual)).status, 400);
});

test("session 不存在、无 cwd 和只读 session 正确拒绝且不保存", async () => {
  const missing = deps({ resolveSessionPath: async () => null });
  assert.equal((await handleSaveRequest(request(validBody), target, missing.actual)).status, 404);
  const noCwd = deps({ readSessionHeader: () => ({}) });
  assert.equal((await handleSaveRequest(request(validBody), target, noCwd.actual)).status, 404);
  const readonly = deps({ requireWritableSession: async () => { throw new FileSaveError("forbidden", "Subagent sessions are read-only"); } });
  assert.equal((await handleSaveRequest(request(validBody), target, readonly.actual)).status, 403);
  assert.equal(readonly.calls.save, 0);
});

test("成功保存透传 target/content/baseline/cwd，并绑定 source session", async () => {
  const { actual, calls } = deps();
  const response = await handleSaveRequest(request(validBody, "source-session"), target, actual);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, path: target, size: 7, mtimeMs: 42 });
  assert.equal(calls.options.target, target);
  assert.equal(calls.options.content, validBody.content);
  assert.deepEqual(calls.options.baseline, validBody.baseline);
  assert.equal(calls.options.cwd, "/tmp/fake-cwd");
  assert.equal(calls.options.sourceSessionId, "source-session");
});

test("FileSaveError 五种状态映射、409 返回当前 baseline，普通异常为 500", async () => {
  const cases = [
    ["bad-request", 400], ["forbidden", 403], ["not-found", 404], ["too-large", 413],
  ];
  for (const [code, status] of cases) {
    const { actual } = deps({ saveFile: () => { throw new FileSaveError(code, "failed"); } });
    assert.equal((await handleSaveRequest(request(validBody), target, actual)).status, status);
  }
  const conflict = deps({ saveFile: () => { throw new FileSaveError("conflict", JSON.stringify({ mtimeMs: 99, size: 8 })); } });
  const conflictResponse = await handleSaveRequest(request(validBody), target, conflict.actual);
  assert.equal(conflictResponse.status, 409);
  assert.deepEqual((await conflictResponse.json()).baseline, { mtimeMs: 99, size: 8 });
  const ordinary = deps({ saveFile: () => { throw new Error("unexpected failure"); } });
  assert.equal((await handleSaveRequest(request(validBody), target, ordinary.actual)).status, 500);
});

test("save orchestration 不解析 upload directory", async () => {
  const { actual, calls } = deps();
  const response = await handleSaveRequest(request(validBody), target, actual);
  assert.equal(response.status, 200);
  assert.equal(calls.roots, 1);
});
