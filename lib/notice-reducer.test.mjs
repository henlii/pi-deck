/**
 * notice-reducer 纯逻辑测试：通知状态机（visible/pending、transient/important、
 * exiting、pinned）的行为契约。逻辑从 hooks/useAgentSession.ts 原样抽出，
 * 本测试固化其语义，防止后续重构漂移。
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": path.join(path.dirname(fileURLToPath(import.meta.url)), "..") },
});
const { noticeReducer, MAX_NOTICES } = await jiti.import("./notice-reducer.ts");

function notice(id, overrides = {}) {
  return {
    id,
    message: `msg-${id}`,
    type: "info",
    tier: "transient",
    pinned: false,
    activityRecord: false,
    ...overrides,
  };
}

function importantNotice(id, overrides = {}) {
  return notice(id, { tier: "important", type: "error", ...overrides });
}

test("add transient：未满时直接 visible；达到 MAX_NOTICES 时最旧 transient 标记 exiting、新进 pending", () => {
  let state = { visible: [], pending: [] };
  for (let i = 0; i < MAX_NOTICES; i++) {
    state = noticeReducer(state, { type: "add", notice: notice(`t${i}`) });
  }
  assert.equal(state.visible.length, MAX_NOTICES);
  assert.equal(state.pending.length, 0);
  // 未满员时各条直接 visible 且无 exiting 标记
  assert.deepEqual(state.visible.map((n) => n.id), ["t0", "t1", "t2", "t3", "t4"]);
  assert.ok(state.visible.every((n) => !n.exiting));

  // 第 MAX_NOTICES+1 条：最旧未 exiting 的 transient 标记 exiting，新条进 pending
  state = noticeReducer(state, { type: "add", notice: notice("overflow") });
  assert.equal(state.visible.length, MAX_NOTICES);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].id, "overflow");
  assert.equal(state.visible[0].id, "t0");
  assert.equal(state.visible[0].exiting, true);
  assert.ok(state.visible.slice(1).every((n) => !n.exiting));
});

test("add transient 且已有 exiting：直接进 pending，不再重复标记", () => {
  let state = { visible: [], pending: [] };
  for (let i = 0; i < MAX_NOTICES; i++) {
    state = noticeReducer(state, { type: "add", notice: notice(`t${i}`) });
  }
  state = noticeReducer(state, { type: "mark_oldest_transient_exiting" }); // t0 exiting
  state = noticeReducer(state, { type: "add", notice: notice("n1") });
  // 已有 exiting 时不再标记第二条
  assert.equal(state.visible.filter((n) => n.exiting).length, 1);
  assert.equal(state.visible[0].id, "t0");
  assert.equal(state.visible[0].exiting, true);
  assert.equal(state.pending.length, 1);
  assert.deepEqual(state.pending.map((n) => n.id), ["n1"]);

  state = noticeReducer(state, { type: "add", notice: notice("n2") });
  assert.equal(state.visible.filter((n) => n.exiting).length, 1);
  assert.deepEqual(state.pending.map((n) => n.id), ["n1", "n2"]);
});

test("add important：总是直接 visible（不计数、不排队）", () => {
  let state = { visible: [], pending: [] };
  for (let i = 0; i < MAX_NOTICES; i++) {
    state = noticeReducer(state, { type: "add", notice: notice(`t${i}`) });
  }
  // 满员后 important 仍直接 visible，不挤占 transient 槽位、不进 pending
  state = noticeReducer(state, { type: "add", notice: importantNotice("imp1") });
  assert.equal(state.visible.length, MAX_NOTICES + 1);
  assert.ok(state.visible.some((n) => n.id === "imp1" && n.tier === "important"));
  assert.equal(state.pending.length, 0);
  // 已有 exiting 时 important 同样直接 visible
  state = noticeReducer(state, { type: "mark_oldest_transient_exiting" });
  state = noticeReducer(state, { type: "add", notice: importantNotice("imp2") });
  assert.equal(state.visible.length, MAX_NOTICES + 2);
  assert.ok(state.visible.some((n) => n.id === "imp2"));
  assert.equal(state.pending.length, 0);
});

test("dismiss：visible 中该条标记 exiting（不删除）；pending 中同 id 移除", () => {
  let state = { visible: [], pending: [] };
  for (let i = 0; i < MAX_NOTICES; i++) {
    state = noticeReducer(state, { type: "add", notice: notice(`t${i}`) });
  }
  state = noticeReducer(state, { type: "add", notice: notice("p1") });
  state = noticeReducer(state, { type: "dismiss", id: "t1" });
  // visible 中的条目仅标记 exiting，不删除、不影响其它条目
  assert.equal(state.visible.length, MAX_NOTICES);
  assert.equal(state.visible.find((n) => n.id === "t1")?.exiting, true);
  assert.equal(state.visible.filter((n) => n.exiting).length, 2); // t0（满员标记）+ t1（dismiss）
  // pending 中同 id 条目移除
  state = noticeReducer(state, { type: "dismiss", id: "p1" });
  assert.equal(state.pending.length, 0);
});

test("toggle_pin：仅 important 可切换 pinned；transient 不切换", () => {
  let state = { visible: [], pending: [] };
  state = noticeReducer(state, { type: "add", notice: importantNotice("imp1") });
  state = noticeReducer(state, { type: "add", notice: notice("tr1") });
  state = noticeReducer(state, { type: "toggle_pin", id: "imp1" });
  assert.equal(state.visible.find((n) => n.id === "imp1")?.pinned, true);
  // transient 调用 toggle_pin 不生效
  state = noticeReducer(state, { type: "toggle_pin", id: "tr1" });
  assert.equal(state.visible.find((n) => n.id === "tr1")?.pinned, false);
  // 再切换回 unpinned
  state = noticeReducer(state, { type: "toggle_pin", id: "imp1" });
  assert.equal(state.visible.find((n) => n.id === "imp1")?.pinned, false);
});

test("mark_oldest_transient_exiting：标记最旧未 exiting 的 transient", () => {
  let state = { visible: [], pending: [] };
  for (let i = 0; i < MAX_NOTICES; i++) {
    state = noticeReducer(state, { type: "add", notice: notice(`t${i}`) });
  }
  state = noticeReducer(state, { type: "mark_oldest_transient_exiting" });
  assert.equal(state.visible[0].id, "t0");
  assert.equal(state.visible[0].exiting, true);
  assert.ok(state.visible.slice(1).every((n) => !n.exiting));

  // 再次调用标记下一条最旧未 exiting 的
  state = noticeReducer(state, { type: "mark_oldest_transient_exiting" });
  assert.equal(state.visible[1].exiting, true);

  // 全部标记后调用幂等（findIndex 找不到即原样返回）
  for (let i = 2; i < MAX_NOTICES; i++) {
    state = noticeReducer(state, { type: "mark_oldest_transient_exiting" });
  }
  assert.ok(state.visible.every((n) => n.exiting));
  const after = noticeReducer(state, { type: "mark_oldest_transient_exiting" });
  assert.equal(after.visible.filter((n) => n.exiting).length, MAX_NOTICES);
});

test("remove：从 visible 删除并回填 pending（补满后无 exiting 则标记最旧 exiting）", () => {
  let state = { visible: [], pending: [] };
  for (let i = 0; i < MAX_NOTICES; i++) {
    state = noticeReducer(state, { type: "add", notice: notice(`t${i}`) });
  }
  // 满员下 add 两条：t0 标记 exiting，p1/p2 排队
  state = noticeReducer(state, { type: "add", notice: notice("p1") });
  state = noticeReducer(state, { type: "add", notice: notice("p2") });
  assert.equal(state.visible[0].exiting, true);
  assert.deepEqual(state.pending.map((n) => n.id), ["p1", "p2"]);

  // 移除已 exiting 的 t0 → p1 回填，visible 满员且无 exiting → 最旧 transient（t1）被标记 exiting
  state = noticeReducer(state, { type: "remove", id: "t0" });
  assert.ok(!state.visible.some((n) => n.id === "t0"));
  assert.equal(state.visible[state.visible.length - 1].id, "p1");
  assert.equal(state.pending.length, 1);
  assert.deepEqual(state.pending.map((n) => n.id), ["p2"]);
  assert.equal(state.visible.filter((n) => n.exiting).length, 1);
  assert.equal(state.visible.find((n) => n.exiting)?.id, "t1");

  // 再移除 exiting 的 t1 → p2 回填，pending 清空后不再标记
  state = noticeReducer(state, { type: "remove", id: "t1" });
  assert.equal(state.visible[state.visible.length - 1].id, "p2");
  assert.equal(state.pending.length, 0);
  assert.equal(state.visible.filter((n) => n.exiting).length, 0);
});

test("FIFO：pending 按插入顺序回填", () => {
  let state = { visible: [], pending: [] };
  for (let i = 0; i < MAX_NOTICES; i++) {
    state = noticeReducer(state, { type: "add", notice: notice(`t${i}`) });
  }
  state = noticeReducer(state, { type: "add", notice: notice("p1") });
  state = noticeReducer(state, { type: "add", notice: notice("p2") });
  state = noticeReducer(state, { type: "add", notice: notice("p3") });
  assert.deepEqual(state.pending.map((n) => n.id), ["p1", "p2", "p3"]);

  // 依次移除 t0（exiting）、t1（回填后被标记 exiting），p1、p2 按序补入 visible
  state = noticeReducer(state, { type: "remove", id: "t0" });
  state = noticeReducer(state, { type: "remove", id: "t1" });
  assert.deepEqual(state.visible.slice(-2).map((n) => n.id), ["p1", "p2"]);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].id, "p3");
});

test("常量导出 MAX_NOTICES === 5", () => {
  assert.equal(MAX_NOTICES, 5);
});
