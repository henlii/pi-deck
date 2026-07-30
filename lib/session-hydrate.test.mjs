import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { hydrateSessionById } = await jiti.import("./session-hydrate.ts");

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("hydrate：404 后成功", async () => {
  let n = 0;
  const delays = [];
  const result = await hydrateSessionById({
    sessionId: "s1",
    isCurrent: () => true,
    maxAttempts: 5,
    baseDelayMs: 10,
    delay: async (ms) => { delays.push(ms); },
    fetchSession: async () => {
      n += 1;
      if (n < 3) return jsonResponse(404, { error: "not found" });
      return jsonResponse(200, { session: { id: "s1", cwd: "/a" } });
    },
    parseBody: (body) => body?.session ?? null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.id, "s1");
  assert.equal(result.attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("hydrate：达到上限停止（全 404）", async () => {
  let n = 0;
  const result = await hydrateSessionById({
    sessionId: "s1",
    isCurrent: () => true,
    maxAttempts: 4,
    baseDelayMs: 1,
    delay: async () => {},
    fetchSession: async () => {
      n += 1;
      return jsonResponse(404, {});
    },
    parseBody: () => null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_found");
  assert.equal(result.attempts, 4);
  assert.equal(n, 4);
});

test("hydrate：abort 停止", async () => {
  const controller = new AbortController();
  let n = 0;
  const resultPromise = hydrateSessionById({
    sessionId: "s1",
    isCurrent: () => true,
    maxAttempts: 6,
    baseDelayMs: 50,
    signal: controller.signal,
    delay: async (ms, signal) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    },
    fetchSession: async () => {
      n += 1;
      if (n === 1) {
        controller.abort();
        return jsonResponse(404, {});
      }
      return jsonResponse(200, { session: { id: "s1" } });
    },
    parseBody: (body) => body?.session ?? null,
  });
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "aborted");
  assert.ok(result.attempts >= 1);
});

test("hydrate：isCurrent false 视为 stale，不更新", async () => {
  let current = true;
  const result = await hydrateSessionById({
    sessionId: "s1",
    isCurrent: () => current,
    maxAttempts: 3,
    baseDelayMs: 1,
    delay: async () => { current = false; },
    fetchSession: async () => jsonResponse(404, {}),
    parseBody: () => ({ id: "s1" }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason === "stale" || result.reason === "aborted" || result.reason === "not_found");
});

test("hydrate：非 404 的 4xx 立即结束", async () => {
  let n = 0;
  const result = await hydrateSessionById({
    sessionId: "s1",
    isCurrent: () => true,
    maxAttempts: 5,
    fetchSession: async () => {
      n += 1;
      return jsonResponse(403, { error: "forbidden" });
    },
    parseBody: () => null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "error");
  assert.equal(result.status, 403);
  assert.equal(n, 1);
});

test("hydrate：成功后 isCurrent 为 false 返回 stale", async () => {
  let current = true;
  const result = await hydrateSessionById({
    sessionId: "s1",
    isCurrent: () => current,
    maxAttempts: 3,
    fetchSession: async () => {
      current = false;
      return jsonResponse(200, { session: { id: "s1" } });
    },
    parseBody: (body) => body?.session ?? null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stale");
});

test("hydrate：只解析匹配 id 的 body（parse 返回 null → error）", async () => {
  const result = await hydrateSessionById({
    sessionId: "s1",
    isCurrent: () => true,
    maxAttempts: 2,
    fetchSession: async () => jsonResponse(200, { session: null }),
    parseBody: (body) => body?.session ?? null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "error");
});

test("hydrate：404 可重试、非404 立即停；与 list cache 失效后可见配合", async () => {
  // 模拟：createNew 已 invalidate 列表缓存后，info 仍可能短窗口 404，
  // 有界重试覆盖该窗口；成功后不再依赖全量 list find。
  let n = 0;
  const result = await hydrateSessionById({
    sessionId: "new-sid",
    isCurrent: () => true,
    maxAttempts: 3,
    baseDelayMs: 1,
    delay: async () => {},
    fetchSession: async () => {
      n += 1;
      if (n === 1) return jsonResponse(404, { error: "Session not found" });
      return jsonResponse(200, {
        session: { id: "new-sid", cwd: "/repo", projectRoot: "/repo" },
      });
    },
    parseBody: (body) => (body?.session?.id === "new-sid" ? body.session : null),
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(n, 2);
});
