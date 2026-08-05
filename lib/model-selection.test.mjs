/**
 * P1-2 模型手动覆盖保留：优先级判定、override 吸附、fork 模型继承（纯函数）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveDisplayModel,
  settleModelOverride,
  shouldInheritModel,
  sameModel,
} from "./model-selection.ts";

const A = { provider: "zenmux", modelId: "claude-a" };
const B = { provider: "zenmux", modelId: "claude-b" };

test("sameModel：一致/空值相等/不一致", () => {
  assert.equal(sameModel(A, A), true);
  assert.equal(sameModel(A, B), false);
  assert.equal(sameModel(null, null), true);
  assert.equal(sameModel(undefined, null), true);
  assert.equal(sameModel(A, null), false);
});

test("resolveDisplayModel：override 最高优先", () => {
  // 用户手动选择 > 磁盘持久化 model_change > 默认
  assert.deepEqual(resolveDisplayModel(A, null, B, null), A);
  assert.deepEqual(resolveDisplayModel(A, B, B, null), A);
});

test("resolveDisplayModel：pending 次之（新会话发送中携带的用户选择）", () => {
  assert.deepEqual(resolveDisplayModel(null, A, B, null), A);
  assert.deepEqual(resolveDisplayModel(null, A, null, null), A);
});

test("resolveDisplayModel：persisted（磁盘 model_change）优先于 fallback", () => {
  assert.deepEqual(resolveDisplayModel(null, null, A, B), A);
});

test("resolveDisplayModel：fallback 兜底，全空返回 null", () => {
  assert.deepEqual(resolveDisplayModel(null, null, null, B), B);
  assert.equal(resolveDisplayModel(null, null, null, null), null);
});

test("settleModelOverride：无 override 保持 null", () => {
  assert.equal(settleModelOverride(null, A), null);
  assert.equal(settleModelOverride(undefined, A), null);
});

test("settleModelOverride：override 与磁盘一致时吸附清除（磁盘权威接管）", () => {
  assert.equal(settleModelOverride(A, A), null);
});

test("settleModelOverride：磁盘缺失（fork 后新会话无 model_change）时保留 override", () => {
  assert.deepEqual(settleModelOverride(A, null), A);
});

test("settleModelOverride：磁盘不一致（写盘竞态/他人修改）时保留 override", () => {
  assert.deepEqual(settleModelOverride(A, B), A);
});

test("shouldInheritModel：新文件无 model_change 且有源模型 → 继承", () => {
  assert.equal(shouldInheritModel(false, A), true);
});

test("shouldInheritModel：新文件已有 model_change → 不继承", () => {
  assert.equal(shouldInheritModel(true, A), false);
  assert.equal(shouldInheritModel(true, null), false);
});

test("shouldInheritModel：源会话无模型 → 无从继承", () => {
  assert.equal(shouldInheritModel(false, null), false);
  assert.equal(shouldInheritModel(false, undefined), false);
});
