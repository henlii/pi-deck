import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// 组件运行时只依赖两个 @/ 模块（i18n / file-paths），精确映射后 jiti 即可加载；
// 其余 @/ import 均为 type-only，转译时被擦除。
const jiti = createJiti(import.meta.url, {
  jsx: true,
  alias: {
    "@/lib/i18n": fileURLToPath(new URL("../lib/i18n.tsx", import.meta.url)),
    "@/lib/file-paths": fileURLToPath(new URL("../lib/file-paths.ts", import.meta.url)),
  },
});

// 纯逻辑直接取自组件文件：活跃判定、轮询间隔、持续时间格式化、
// agent 名称去重与 step 状态映射。组件渲染不在此测试范围。
const {
  isActiveSubagentRun,
  countActiveSubagentRuns,
  resolveRunPollDelayMs,
  formatRunDurationMs,
  runDurationMs,
  runAgentNames,
  stepStatusKey,
} = await jiti.import("./SubagentRunsPanel.tsx");

test("isActiveSubagentRun: queued/running 为活跃，终态不活跃", () => {
  assert.equal(isActiveSubagentRun({ state: "queued" }), true);
  assert.equal(isActiveSubagentRun({ state: "running" }), true);
  assert.equal(isActiveSubagentRun({ state: "complete" }), false);
  assert.equal(isActiveSubagentRun({ state: "failed" }), false);
  assert.equal(isActiveSubagentRun({ state: "paused" }), false);
  assert.equal(isActiveSubagentRun({ state: "stopped" }), false);
});

test("countActiveSubagentRuns: 只统计 queued/running", () => {
  const runs = [
    { state: "running" },
    { state: "complete" },
    { state: "queued" },
    { state: "failed" },
  ];
  assert.equal(countActiveSubagentRuns(runs), 2);
  assert.equal(countActiveSubagentRuns([]), 0);
});

test("resolveRunPollDelayMs: 隐藏不排程，活跃 2s，空闲 8s", () => {
  assert.equal(resolveRunPollDelayMs(true, true), null);
  assert.equal(resolveRunPollDelayMs(false, true), null);
  assert.equal(resolveRunPollDelayMs(true, false), 2000);
  assert.equal(resolveRunPollDelayMs(false, false), 8000);
});

test("formatRunDurationMs: 秒 / 分秒 / 小时分紧凑格式", () => {
  assert.equal(formatRunDurationMs(0), "0s");
  assert.equal(formatRunDurationMs(59_400), "59s");
  assert.equal(formatRunDurationMs(60_000), "1m");
  assert.equal(formatRunDurationMs(192_000), "3m 12s");
  assert.equal(formatRunDurationMs(3_600_000), "1h");
  assert.equal(formatRunDurationMs(7_500_000), "2h 5m");
  // 负值按 0 处理（时钟回拨不产生负时长）
  assert.equal(formatRunDurationMs(-1000), "0s");
});

test("runDurationMs: 进行中用 now 补齐，终态用 endedAt，无 startedAt 返回 null", () => {
  assert.equal(runDurationMs({ startedAt: 1000, endedAt: 4000 }, 9000), 3000);
  assert.equal(runDurationMs({ startedAt: 1000 }, 5000), 4000);
  assert.equal(runDurationMs({ endedAt: 4000 }, 9000), null);
  // endedAt 早于 startedAt（异常数据）不为负
  assert.equal(runDurationMs({ startedAt: 5000, endedAt: 1000 }, 9000), 0);
});

test("runAgentNames: 按 steps 顺序去重，空 agent 跳过", () => {
  const steps = [
    { agent: "researcher" },
    { agent: "writer" },
    { agent: "researcher" },
    { agent: "" },
  ];
  assert.deepEqual(runAgentNames({ steps }), ["researcher", "writer"]);
  assert.deepEqual(runAgentNames({ steps: [] }), []);
});

test("stepStatusKey: 已知状态映射 i18n 键，未知返回 null", () => {
  assert.equal(stepStatusKey("running"), "runs_stateRunning");
  assert.equal(stepStatusKey("OK"), "runs_stateComplete");
  assert.equal(stepStatusKey(" done "), "runs_stateComplete");
  assert.equal(stepStatusKey("error"), "runs_stateFailed");
  assert.equal(stepStatusKey("skipped"), "runs_stateSkipped");
  assert.equal(stepStatusKey("some_custom_status"), null);
});
