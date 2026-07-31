#!/usr/bin/env node
/**
 * Pidance 持续测试版（31416）systemd 持久守护安装/卸载脚本。
 *
 * 背景：local-deploy.mjs 用 systemd-run 创建 transient unit（Restart=no），
 * 系统重启后不会自启、/tmp 状态与日志一并丢失。本脚本把 31416 测试版
 * 升级为持久 unit（Restart=always + enable），使工作区测试服务常驻：
 * 开机自启、崩溃自动拉起，且 local-deploy.mjs 的 restart/status 继续可用。
 *
 * 硬边界（与 AGENTS.md 一致）：
 * - 只操作 unit pidance-local-31416-<uid>.service；永不触碰 30141（上游
 *   pi-web）与 31415 正式版（pidance.service）。
 * - 同名 transient unit 接管前必须指纹校验（WorkingDirectory=仓库）；
 *   指纹不符拒绝操作。
 * - ExecStart 使用稳定 Node 入口（/root/.local/bin 优先，勿写 NVM 版本目录）
 *   与仓库内 Next CLI 绝对路径；日志独立于正式版（/var/log）。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repository = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const host = "0.0.0.0";
const port = 31416;
const healthUrl = "http://127.0.0.1:31416/api/home";
const uid = process.getuid?.() ?? "user";
const unitName = `pidance-local-31416-${uid}.service`;
const unitFile = `/etc/systemd/system/${unitName}`;
const logFile = `/var/log/${unitName}.log`;
const memoryHigh = "3G";
const memoryMax = "4G";

// 稳定 Node 入口：优先 /root/.local/bin/node（pidance.service 同款约定），
// 若与当前 execPath 指向同一文件则使用之，否则退回 process.execPath。
function resolveStableNode() {
  const candidates = ["/root/.local/bin/node"];
  for (const candidate of candidates) {
    try {
      if (realpathSync(candidate) === realpathSync(process.execPath)) return candidate;
    } catch { /* 候选不存在，继续 */ }
  }
  return process.execPath;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function unitShow() {
  const result = run("systemctl", ["show", unitName, "--property=ActiveState,SubState,MainPID,WorkingDirectory,FragmentPath,LoadState", "--no-pager"]);
  if (result.status !== 0) return null;
  const props = {};
  for (const line of (result.stdout || "").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return props.LoadState ? props : null;
}

function fail(message) { throw new Error(message); }

function assertOwnedTransient(props) {
  if (!props || props.LoadState === "not-found" || props.FragmentPath?.startsWith("/run/systemd/transient/")) {
    if (props?.WorkingDirectory && props.WorkingDirectory !== repository) {
      fail(`拒绝接管：同名 unit ${unitName} 的 WorkingDirectory=${props.WorkingDirectory} 非本仓库`);
    }
    return;
  }
  if (props.FragmentPath?.startsWith("/etc/systemd/system/")) return; // 已是持久 unit
  fail(`拒绝操作：unit ${unitName} 来源未知（${props?.FragmentPath ?? "?"}）`);
}

function buildUnitContent(nodeBin, nextCli) {
  return [
    "# Pidance 持续测试版（31416）systemd 守护单元（由 scripts/install-31416-daemon.mjs 生成）",
    "# 仅此单元：pidance-local-31416-<uid>.service；31415 正式版见 pidance.service；30141 归上游 pi-web，永不操作",
    "",
    "[Unit]",
    "Description=Pidance continuous test deploy (workspace, 31416)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "User=root",
    "Group=root",
    `Environment=HOME=/root`,
    `Environment=PI_CODING_AGENT_DIR=/root/.pi/agent`,
    `Environment=PATH=/root/.pi/agent/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    `Environment=NODE_OPTIONS=--max-old-space-size=3072`,
    `WorkingDirectory=${repository}`,
    // 绝对稳定路径：仓库内 Next CLI；Turbopack dev 反复 HMR 后耗尽 V8 堆，固定 --webpack
    `ExecStart=${nodeBin} ${nextCli} dev --webpack -H ${host} -p ${String(port)}`,
    // 崩溃（异常退出）自动拉起；systemctl stop 正常停止不触发重启
    "Restart=always",
    "RestartSec=3",
    "KillMode=control-group",
    "TimeoutStopSec=30",
    "LimitNOFILE=65536",
    `MemoryHigh=${memoryHigh}`,
    `MemoryMax=${memoryMax}`,
    // 日志独立于正式版（journal），进持久文件
    `StandardOutput=append:${logFile}`,
    `StandardError=append:${logFile}`,
    "StandardInput=null",
    "SyslogIdentifier=pidance-local-31416",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(healthUrl);
      if (response.status >= 200 && response.status < 300) return true;
    } catch { /* 等待监听 */ }
    await new Promise((done) => setTimeout(done, 500));
  }
  return false;
}

async function install() {
  const nodeBin = resolveStableNode();
  const nextCli = join(repository, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextCli)) fail(`Next CLI 不存在：${nextCli}`);
  if (!existsSync(unitFile)) {
    // 接管同名残留 unit（local-deploy 遗留）：先停（含指纹校验）；not-found 残留直接覆盖
    const props = unitShow();
    if (props && props.LoadState !== "not-found") {
      assertOwnedTransient(props);
      if (props.ActiveState === "active" || props.ActiveState === "activating") {
        const stop = run("systemctl", ["stop", unitName]);
        if (stop.status !== 0) fail(`停止遗留 transient unit 失败：${(stop.stderr || stop.stdout || "").trim()}`);
      }
    }
  } else {
    const props = unitShow();
    if (props && !props.FragmentPath?.startsWith("/etc/systemd/system/")) {
      fail(`unit ${unitName} 已存在但来源异常（${props.FragmentPath}），拒绝覆盖`);
    }
  }
  writeFileSync(unitFile, buildUnitContent(nodeBin, nextCli), { mode: 0o644 });
  chmodSync(unitFile, 0o644);
  const reload = run("systemctl", ["daemon-reload"]);
  if (reload.status !== 0) fail(`daemon-reload 失败：${(reload.stderr || "").trim()}`);
  const enable = run("systemctl", ["enable", unitName]);
  if (enable.status !== 0) fail(`enable 失败：${(enable.stderr || enable.stdout || "").trim()}`);
  const start = run("systemctl", ["restart", unitName]);
  if (start.status !== 0) fail(`start 失败：${(start.stderr || start.stdout || "").trim()}`);
  if (!(await waitForHealth())) {
    fail(`部署未通过健康检查；日志：${logFile}`);
  }
  const props = unitShow();
  console.log(JSON.stringify({
    unit: unitName,
    file: unitFile,
    logFile,
    pid: Number(props?.MainPID || 0),
    active: props?.ActiveState === "active",
    enabled: true,
    url: healthUrl,
  }, null, 2));
}

function uninstall() {
  const props = unitShow();
  if (!props) fail(`unit ${unitName} 不存在`);
  assertOwnedTransient(props);
  if (!props.FragmentPath?.startsWith("/etc/systemd/system/")) {
    fail(`unit ${unitName} 不是持久 unit（${props.FragmentPath}），拒绝卸载；请用 local-deploy.mjs stop`);
  }
  const disable = run("systemctl", ["disable", unitName]);
  if (disable.status !== 0) fail(`disable 失败：${(disable.stderr || "").trim()}`);
  const stop = run("systemctl", ["stop", unitName]);
  if (stop.status !== 0) fail(`stop 失败：${(stop.stderr || "").trim()}`);
  rmSync(unitFile, { force: true });
  run("systemctl", ["daemon-reload"]);
  console.log(`已卸载 ${unitName}（31416 已释放；30141/31415 未被操作）`);
}

function status() {
  const props = unitShow();
  if (!props) return console.log(`unit ${unitName} 未安装`);
  console.log(JSON.stringify({
    unit: unitName,
    file: props.FragmentPath,
    active: props.ActiveState === "active",
    state: props.ActiveState,
    subState: props.SubState,
    pid: Number(props.MainPID || 0),
    logFile,
    persistent: Boolean(props.FragmentPath?.startsWith("/etc/systemd/system/")),
  }, null, 2));
}

function help() {
  console.log([
    "用法：node scripts/install-31416-daemon.mjs <install|uninstall|status|help>",
    `install：把 31416 测试版部署为持久 systemd unit ${unitName}（Restart=always + enable 自启），`,
    "         接管同名 transient unit（指纹校验后），健康检查通过后输出状态。",
    "uninstall：disable + stop + 删除 unit 文件，恢复由 local-deploy.mjs 管理。",
    "永不操作 30141（上游 pi-web）与 31415 正式版（pidance.service）。",
  ].join("\n"));
}

const command = process.argv[2] ?? "help";
try {
  if (command === "install") install();
  else if (command === "uninstall") uninstall();
  else if (command === "status") status();
  else if (command === "help") help();
  else fail(`未知命令：${command}`);
} catch (error) {
  console.error(`错误：${error instanceof Error ? error.message : "操作失败"}`);
  process.exitCode = 1;
}
