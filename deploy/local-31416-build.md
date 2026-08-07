# 工作区持续测试（31416）构建方法参考

> **范围**：仅工作区源码 → 持续测试服务 **31416**（`local-deploy` / `pidance-local-31416-<uid>`）。  
> **不**用于正式安装 31415、npm 发布、GitHub Release。发布仍走 `npm run build`（`--webpack`）+ 发布审计。  
> **永不操作** 30141（上游 pi-web）。

## 目标

改代码后尽快把当前工作区部署到 31416，构建墙钟时间控制在 **几十秒**（温构建），避免原先 webpack 分钟级（叠加双 build 时约 10 分钟）。

## 方法（已验证）

| 项 | 31416 测试构建 | 正式/发布构建 |
|----|----------------|---------------|
| 命令 | `next build --turbopack` | `next build --webpack`（`npm run build`） |
| 产物目录 | `.next-public`（`PIDANCE_DIST_DIR=.next-public`） | `.next` |
| 类型检查 | 构建内跳过（`typescript.ignoreBuildErrors`，仅 `.next-public`） | 严格（构建内检查） |
| 磁盘缓存 | `experimental.turbopackFileSystemCacheForBuild: true` → `.next-public/cache/turbopack` | webpack 自有 cache |
| 入口脚本 | `node .agents/skills/pidance-development/scripts/local-deploy.mjs restart` | 发布隔离 checkout + 审计 |

### 实测（本机，Next 16.2.11，2026-08-07）

| 场景 | 墙钟 |
|------|------|
| **冷构建**（删除整个 `.next-public` 后） | **~41s** |
| **温构建**（无源码变更再 build） | **~16s** |
| **温构建**（小改一行再 build） | **~14s** |

说明：

- 日常改代码后的常态是**温构建**；「几十秒」以温构建为准。
- 冷构建已可压到约 40s；依赖大版本变更或清缓存后仍可能更长。
- 历史上弃用 Turbopack 的原因是 **`next dev` 长跑 HMR 堆膨胀**，**不**适用于一次性 `next build` + `next start` 的 31416 模式。

### 配置要点（`next.config.ts`）

- `distDir = process.env.PIDANCE_DIST_DIR || ".next"`
- `typescript.ignoreBuildErrors` **仅当** `PIDANCE_DIST_DIR === ".next-public"`
- `experimental.turbopackFileSystemCacheForBuild: true`（Next 16.2 需显式；16.3 起默认）
- `webpack()` 回调只服务发布路径；Turbopack 忽略该回调，依赖 `serverExternalPackages` + 原生 `node:` 处理

### 脚本要点（`local-deploy.mjs`）

1. **单次 build**：`buildForProduction` 内 `next build --turbopack`，且 **必须** 把 `PIDANCE_DIST_DIR=.next-public` 传入 spawn 的 `env`（`runTool` 第三参）。若 env 未传入，产物会写到默认 `.next`，unit 仍读 `.next-public`，表现为「构建完成但服务仍是旧代码」。
2. **保留缓存**：不要在每次 restart 时删除整个 `.next-public`；异常时再整目录清缓存。
3. **unit 不 build**：`install-31416-daemon.mjs` 的 unit **无** `ExecStartPre=next build`，只 `next start`；代码更新只走 local-deploy 这一次 build。
4. 构建结束打印耗时秒数，便于对照温/冷。

## 操作

```bash
# 工作区根
node .agents/skills/pidance-development/scripts/local-deploy.mjs restart
# 期望日志含：构建 31416 测试产物（Turbopack → .next-public…）与「构建完成（NNs）」
```

手动等价：

```bash
PIDANCE_DIST_DIR=.next-public node node_modules/next/dist/bin/next build --turbopack
# 再 systemctl restart pidance-local-31416-<uid>.service
```

清缓存（构建异常或升级 Next 大版本后）：

```bash
rm -rf .next-public
# 再 local-deploy restart（冷构建）
```

类型安全不依赖测试构建：

```bash
npm run typecheck   # 或 npm run check
```

## 风险与边界

| 风险 | 处理 |
|------|------|
| Turbopack 与 webpack 产物差异 | 正式发布永远 `--webpack`；31416 只做测试 |
| NFT / 全仓 trace 警告 | 当前可出现于 next.config 读 package.json 路径；观察即可，不阻塞 start |
| 缓存陈旧 | 删 `.next-public` 冷构建 |
| 跳过 typecheck | 仅测试产物；提交/发布前跑 `typecheck` |

## 与正式部署文档 / skill 的关系

- 本文件：**31416 工作区测试构建**加速参考（项目事实 + 实测）。  
- `deploy/README.md`：**31415 正式安装**治理（tgz、systemd 模板、反代只指 31415）。  
- 全局部署 skill **nm-deploy**：可复用清单见  
  `~/.agents/skills/nm-deploy/references/local-test-build-speed.md`（测试/发布拆分、单次 build、spawn env）。  
- 项目 skill **pidance-development**：开发时强制 `local-deploy restart`，并指向本文。  

二者目录/进程/产物/日志 **不可混用**。
