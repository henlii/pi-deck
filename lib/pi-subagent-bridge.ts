/**
 * Pidance → pi-subagents 的 pi CLI 桥接。
 *
 * pi-subagents 执行子代理时需 spawn pi CLI，其解析链为：
 *   1. PI_SUBAGENT_PI_BINARY 环境变量（本模块设置的入口）；
 *   2. process.argv[1] 探测 —— Next server 入口不是 pi-coding-agent，失败；
 *   3. import.meta.resolve("@earendil-works/pi-coding-agent") —— 从
 *      ~/.pi/agent/npm/node_modules 加载的 pi-subagents 位置解析不到，失败；
 *   4. fallback spawn("pi") —— 依赖 PATH；31415 正式安装的 PATH 不含 pi，
 *      直接 ENOENT，所有 subagent 调用失败。
 *
 * 因此 Pidance 在 server 启动时（instrumentation.register）把
 * PI_SUBAGENT_PI_BINARY 指向本包依赖的 dist/cli.js（带 shebang + 可执行位），
 * 使子代理与主进程使用同一版本 pi，且不依赖上游 pi-web 的安装布局。
 */

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** pi-subagents 读取的环境变量名（镜像其 PI_SUBAGENT_PI_BINARY_ENV）。 */
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";

const RELATIVE_CLI = join(
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);

function isRunnableCliFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * 从本模块位置或 cwd 向上查找 Pidance 自带 pi-coding-agent 的 CLI 入口。
 * 编译产物位于 .next/server/（next start / next dev 均如此），向上若干级
 * 即可命中包根 node_modules；test fixture 场景则从 lib/ 向上命中。
 */
export function resolvePidancePiCli(): string | null {
  // 从 cwd 向上若干级查找：next start / next dev 的 cwd 均为包根，
  // 安装 tgz 后亦如此；不使用 import.meta.url，避免 webpack 产物
  // 嵌入构建机源码绝对路径（发布审计红线）与 CJS bundle 语义差异。
  let dir = resolve(process.cwd());
  for (let level = 0; level < 12 && dir !== dirname(dir); level++) {
    const candidate = join(dir, RELATIVE_CLI);
    if (isRunnableCliFile(candidate)) return resolve(candidate);
    dir = dirname(dir);
  }
  return null;
}

/**
 * 设置 PI_SUBAGENT_PI_BINARY 指向 Pidance 自带 pi CLI；返回设置的路径，
 * 解析失败返回 null（调用方按可降级处理，不阻塞启动）。
 * Windows 无 shebang 直接执行语义，跳过（保留 pi-subagents 自身 fallback）。
 */
export function configurePiSubagentBinary(): string | null {
  if (process.platform === "win32") return null;
  const cli = resolvePidancePiCli();
  if (!cli) return null;
  process.env[PI_SUBAGENT_PI_BINARY_ENV] = cli;
  return cli;
}
