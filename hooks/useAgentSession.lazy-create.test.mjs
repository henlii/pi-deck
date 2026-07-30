/**
 * Issue #13：新会话 lazy creation 纯逻辑与 ensure 门禁（不挂 React）。
 * 覆盖：空态不 ensure；并发 ensure 单飞；promote 携带 intent；cwd 捕获。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const intent = await jiti.import("../lib/new-session-intent.ts");

/** 模拟 ensureNewSession 单飞 + 成功后 sid 复用（与 hook 语义对齐）。 */
function createEnsureSimulator() {
  /** @type {string | null} */
  let sessionId = null;
  /** @type {Promise<string | null> | null} */
  let ensuring = null;
  /** @type {string[]} */
  const posts = [];
  /** @type {string[]} */
  const ensureCwds = [];

  async function ensureNewSession(isNew, cwd, bodyCwd) {
    if (sessionId) return sessionId;
    if (!isNew || !cwd) return sessionId;
    if (ensuring) return ensuring;
    const captured = bodyCwd ?? cwd;
    ensuring = (async () => {
      posts.push("/api/agent/new");
      ensureCwds.push(captured);
      await Promise.resolve();
      sessionId = `sid-${posts.length}-${captured.split("/").pop()}`;
      return sessionId;
    })();
    try {
      return await ensuring;
    } finally {
      ensuring = null;
    }
  }

  return {
    get sessionId() { return sessionId; },
    get posts() { return posts; },
    get ensureCwds() { return ensureCwds; },
    ensureNewSession,
    /** 模拟空态 loadSlashCommands：无 sid 不 ensure */
    async loadSlashCommands() {
      if (!sessionId) return [];
      return [{ name: "x" }];
    },
  };
}

test("A1：空态 mount/读资源不 POST /api/agent/new", async () => {
  const sim = createEnsureSimulator();
  const cmds = await sim.loadSlashCommands(true);
  assert.deepEqual(cmds, []);
  assert.equal(sim.posts.length, 0);
  assert.equal(sim.sessionId, null);
});

test("A2：首次 prompt 两个并发入口只 ensure 一次", async () => {
  const sim = createEnsureSimulator();
  const [a, b] = await Promise.all([
    sim.ensureNewSession(true, "/repo"),
    sim.ensureNewSession(true, "/repo"),
  ]);
  assert.equal(a, b);
  assert.equal(sim.posts.length, 1);
  assert.equal(sim.sessionId, a);
});

test("A3：ensure 成功后复用 sid，不二次创建", async () => {
  const sim = createEnsureSimulator();
  const first = await sim.ensureNewSession(true, "/repo");
  // 模拟 prompt/SSE 失败后重试
  const second = await sim.ensureNewSession(true, "/repo");
  assert.equal(first, second);
  assert.equal(sim.posts.length, 1);
});

test("A4/B：新 intent 后旧 ensure 不选中；B 请求用 B cwd", async () => {
  const intentA = intent.createNewSessionIntent("/cwd-a", 1, () => "ia");
  const intentB = intent.createNewSessionIntent("/cwd-b", 2, () => "ib");

  // A 迟到 promote 被拒
  assert.equal(
    intent.shouldPromoteSessionCreated({
      currentIntentId: intentB.id,
      eventIntentId: intentA.id,
      selectedSessionId: null,
      createdSessionId: "sid-a",
    }),
    false,
  );

  const sim = createEnsureSimulator();
  // 用户已切到 B：ensure 用 B 的捕获 cwd
  const sidB = await sim.ensureNewSession(true, intentB.cwd, intentB.cwd);
  assert.equal(sim.ensureCwds[0], "/cwd-b");
  assert.ok(sidB.includes("cwd-b") || sim.ensureCwds[0] === "/cwd-b");

  assert.equal(
    intent.shouldPromoteSessionCreated({
      currentIntentId: intentB.id,
      eventIntentId: intentB.id,
      selectedSessionId: null,
      createdSessionId: sidB,
    }),
    true,
  );
});

test("A：ensure 成功即应 promote（即使后续失败也保留 sid 事实）", async () => {
  const sim = createEnsureSimulator();
  const sid = await sim.ensureNewSession(true, "/repo");
  // promote 条件：有 sid；后续 prompt 失败不清除 sid
  assert.ok(sid);
  assert.equal(await sim.ensureNewSession(true, "/repo"), sid);
  assert.equal(sim.posts.length, 1);
});

test("多 pending：A 迟到不选中 B，但 A 仍应作为真实 session 保留（promote=false）", async () => {
  // AppShell multi-pending 契约：shouldPromote=false 时仍 upsert pending map
  const keepPending = [];
  const onCreated = (session, intentId, currentIntentId, selectedId) => {
    const promote = intent.shouldPromoteSessionCreated({
      currentIntentId,
      eventIntentId: intentId,
      selectedSessionId: selectedId,
      createdSessionId: session.id,
    });
    keepPending.push(session.id);
    return promote;
  };

  const promoteA = onCreated(
    { id: "sid-a", cwd: "/a" },
    "intent-a",
    "intent-b",
    null,
  );
  assert.equal(promoteA, false);
  assert.deepEqual(keepPending, ["sid-a"]);

  const promoteB = onCreated(
    { id: "sid-b", cwd: "/b" },
    "intent-b",
    "intent-b",
    null,
  );
  assert.equal(promoteB, true);
  assert.deepEqual(keepPending, ["sid-a", "sid-b"]);
});
