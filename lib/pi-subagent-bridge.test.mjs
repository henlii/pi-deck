import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, statSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PI_SUBAGENT_PI_BINARY_ENV,
  resolvePidancePiCli,
  configurePiSubagentBinary,
} = await jiti.import("./pi-subagent-bridge.ts");

test("resolvePidancePiCli 返回 Pidance 自带 pi-coding-agent 的 CLI 入口", () => {
  const cli = resolvePidancePiCli();
  assert.ok(cli, "应解析到 cli.js 路径");
  assert.match(cli, /@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js$/);
  assert.ok(existsSync(cli), "cli.js 必须存在");
  assert.ok(statSync(cli).isFile(), "必须是常规文件");
});

test("configurePiSubagentBinary 设置 PI_SUBAGENT_PI_BINARY 并返回路径", () => {
  const previous = process.env[PI_SUBAGENT_PI_BINARY_ENV];
  try {
    const cli = configurePiSubagentBinary();
    assert.ok(cli, "应成功配置");
    assert.equal(process.env[PI_SUBAGENT_PI_BINARY_ENV], cli);
    assert.ok(existsSync(process.env[PI_SUBAGENT_PI_BINARY_ENV]));
  } finally {
    if (previous === undefined) delete process.env[PI_SUBAGENT_PI_BINARY_ENV];
    else process.env[PI_SUBAGENT_PI_BINARY_ENV] = previous;
  }
});
