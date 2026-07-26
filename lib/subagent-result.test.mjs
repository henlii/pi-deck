import assert from "node:assert/strict";
import test from "node:test";
import { parseSubagentResult, SUBAGENT_TOOL_NAME } from "./subagent-result.ts";

const usage = (over = {}) => ({ input: 100, output: 20, cacheRead: 5, cacheWrite: 1, cost: 0.02, turns: 3, ...over });

const run = (over = {}) => ({ agent: "delegate", task: "做点事", exitCode: 0, usage: usage(), ...over });

const details = (over = {}) => ({ mode: "single", runId: "abc123", results: [run()], ...over });

test("工具名常量与 pi-subagents 契约一致", () => {
  assert.equal(SUBAGENT_TOOL_NAME, "subagent");
});

test("A3: 形状不匹配返回 null，由调用方回退文本渲染", () => {
  for (const value of [undefined, null, "text", 42, [], {}, { results: {} }, { results: [] }, { results: ["x", 1] }]) {
    assert.equal(parseSubagentResult(value), null);
  }
});

test("A3: 解析单个子运行的核心字段", () => {
  const parsed = parseSubagentResult(details({
    results: [run({
      agent: "scout",
      model: "new-api/gpt-5.6-sol:low",
      finalOutput: "调查完成",
      sessionFile: "/root/.pi/agent/sessions/x/run-0/session.jsonl",
      acceptance: { status: "verified", explicit: true },
    })],
  }));
  assert.equal(parsed.mode, "single");
  assert.equal(parsed.runId, "abc123");
  assert.equal(parsed.runs.length, 1);
  assert.deepEqual(
    { ...parsed.runs[0], usage: undefined },
    {
      index: 0,
      agent: "scout",
      task: "做点事",
      status: "ok",
      model: "new-api/gpt-5.6-sol:low",
      failedModels: undefined,
      usage: undefined,
      acceptanceStatus: "verified",
      finalOutput: "调查完成",
      error: undefined,
      sessionFile: "/root/.pi/agent/sessions/x/run-0/session.jsonl",
      nestedRuns: undefined,
    },
  );
  assert.deepEqual(parsed.runs[0].usage, usage());
});

test("A3: 状态按优先级派生 timeout > stopped > interrupted > detached > error > ok", () => {
  const status = (over) => parseSubagentResult(details({ results: [run(over)] })).runs[0].status;
  assert.equal(status({}), "ok");
  assert.equal(status({ exitCode: 1 }), "error");
  assert.equal(status({ error: "boom" }), "error");
  assert.equal(status({ detached: true }), "detached");
  assert.equal(status({ detached: true, interrupted: true }), "interrupted");
  assert.equal(status({ interrupted: true, stopped: true }), "stopped");
  assert.equal(status({ stopped: true, timedOut: true }), "timeout");
  assert.equal(status({ timedOut: true, exitCode: 1, error: "boom" }), "timeout");
});

test("A3: 模型回退链排除最终生效模型，两种来源都支持", () => {
  const failed = (over) => parseSubagentResult(details({ results: [run(over)] })).runs[0].failedModels;
  assert.deepEqual(failed({
    model: "b",
    modelAttempts: [{ model: "a", success: false }, { model: "b", success: true }],
  }), ["a"]);
  assert.deepEqual(failed({ model: "b", attemptedModels: ["a", "b"] }), ["a"]);
  assert.equal(failed({ model: "a", modelAttempts: [{ model: "a", success: true }] }), undefined);
  assert.equal(failed({ model: "a" }), undefined);
  // 整体失败时最终模型即失败模型，不重复列入回退链
  assert.equal(failed({ model: "a", modelAttempts: [{ model: "a", success: false }] }), undefined);
});

test("A3: 损坏子运行只跳过该条，不丢弃整张卡片", () => {
  const parsed = parseSubagentResult(details({ results: ["坏数据", run({ agent: "worker" }), null] }));
  assert.equal(parsed.runs.length, 1);
  assert.equal(parsed.runs[0].agent, "worker");
  assert.equal(parsed.runs[0].index, 1, "index 取自原始位置，用作稳定 key");
});

test("A3: 可选字段缺失时降级为 undefined 而非抛错", () => {
  const parsed = parseSubagentResult({ results: [{}] });
  assert.deepEqual(parsed.runs[0], {
    index: 0,
    agent: undefined,
    task: undefined,
    status: "ok",
    model: undefined,
    failedModels: undefined,
    usage: undefined,
    acceptanceStatus: undefined,
    finalOutput: undefined,
    error: undefined,
    sessionFile: undefined,
    nestedRuns: undefined,
  });
  assert.equal(parsed.mode, undefined);
  assert.equal(parsed.totalUsage, undefined);
  assert.equal(parsed.totalCost, undefined);
  assert.equal(parseSubagentResult({ results: [run({ usage: { turns: 2 } })] }).runs[0].usage, undefined);
});

test("A3: 并行与链式运行保留全部子运行与链信息", () => {
  const parsed = parseSubagentResult(details({
    mode: "chain",
    chainAgents: ["scout", "planner", 42],
    results: [run({ agent: "scout" }), run({ agent: "planner", exitCode: 1, error: "失败" })],
    totalChildUsage: usage({ input: 1000 }),
    totalCost: { inputTokens: 1000, outputTokens: 40, costUsd: 0.5 },
  }));
  assert.deepEqual(parsed.chainAgents, ["scout", "planner"]);
  assert.deepEqual(parsed.runs.map((r) => [r.agent, r.status]), [["scout", "ok"], ["planner", "error"]]);
  assert.equal(parsed.totalUsage.input, 1000);
  assert.equal(parsed.totalCost, 0.5);
});

test("A3: 嵌套子运行计数与 run 级超时/停止标记", () => {
  const parsed = parseSubagentResult(details({
    results: [run({ children: [{ id: "a" }, { id: "b" }] })],
    timedOut: true,
  }));
  assert.equal(parsed.runs[0].nestedRuns, 2);
  assert.equal(parsed.timedOut, true);
  assert.equal(parsed.stopped, undefined);
  assert.equal(parseSubagentResult(details({ results: [run({ children: [] })] })).runs[0].nestedRuns, undefined);
});

test("A3: 不变异输入", () => {
  const input = details({ results: [run({ modelAttempts: [{ model: "a", success: false }] })] });
  const before = structuredClone(input);
  parseSubagentResult(input);
  assert.deepEqual(input, before);
});
