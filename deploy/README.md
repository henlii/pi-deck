# Pidance 正式安装部署治理

本目录仅描述 **Pidance（`@henlii/pidance`，CLI 仅 `pidance`）正式安装版** 在项目内的部署约定与 systemd 单元模板。
**不**覆盖上游 pi-web、工作区持续测试版，也**不**自动执行安装 / 启停 / 反代切换 / npm publish。

> **参考（非本流程）**：工作区 **31416** 持续测试的 Turbopack 快速构建方法见  
> [`local-31416-build.md`](./local-31416-build.md)（与正式 tgz/31415 隔离，勿混用产物目录）。

## 硬边界

| 对象 | 端口 / 标识 | 本流程是否可操作 |
|------|-------------|------------------|
| Pidance **正式安装版** | `0.0.0.0:31415` | 是（本目录唯一目标） |
| Pidance **工作区持续测试** | `31416` | **否**（独立目录 / `.next` / PID / 日志） |
| 上游 **pi-web** | `30141`、命令 `pi-web` | **永不操作** |
| 待退役旧反代后端 | `30143` | **不作为当前端口**，勿写入新配置 |

- 正式版**必须**从**已审计的同一 tgz** 安装，**禁止**直接从工作区源码以生产方式常驻运行。
- 反代（如 Nginx）**只能**在正式服务健康后指向 **31415**，不得指向 31416 / 30141 / 30143。
- 服务以 **root** 运行（Pi 数据在 `/root/.pi/agent`）：`HOME=/root`，`PI_CODING_AGENT_DIR=/root/.pi/agent`。
- Node 使用标准 nvm 绝对路径（`/root/.nvm/versions/node/v24.18.0/bin/node`），unit 的 ExecStart/PATH 直接写该路径，**不要**用 `/root/.local/bin` 软连接、**不要**把版本化路径再包一层。
- CLI：`pidance --hostname 0.0.0.0 --port 31415 --no-open`。
- **禁止**在本目录或 unit 中写入 API 密钥、口令、私钥等敏感值。

## 目录布局

建议固定根：`/opt/pidance/`。

```
/opt/pidance/
  artifacts/                          # 独立制品区：只放已验收 tgz + 同名 .sha256
    pidance-<version-or-sha>.tgz
    pidance-<version-or-sha>.tgz.sha256
  releases/
    <version-or-sha>/                 # 每次发布一个空目录，再 npm 安装进该目录
      package.json                    # npm init 生成
      node_modules/
        .bin/pidance                  # 稳定 CLI 入口（systemd ExecStart 用此路径）
        @henlii/pidance/              # 包本体（含 bin/、.next/、public/ 等）
        ...                           # production dependencies
  current -> releases/<version-or-sha>   # 原子切换用符号链接
```

说明：

1. **tgz 与 SHA256 只放在 `artifacts/`**，不要混进 `releases/<ver>/`，便于审计与回滚对照。
2. **`current` 是运行时唯一指针**；回滚 = 改 symlink 后 `systemctl restart pidance`。
3. 正式版、测试版、上游 pi-web 的目录 / 进程 / 构建产物 / PID / 日志**绝对不可混用**。

## 正式安装（同一 tgz + SHA 校验）

以下为**人工操作说明**（本仓库脚本不会代你执行）。

### 1. 准备制品

将已通过 allowlist 审计、且与 GitHub Release / npm 发布物一致的 tgz 与 SHA256 文件放入：

```text
/opt/pidance/artifacts/pidance-<version-or-sha>.tgz
/opt/pidance/artifacts/pidance-<version-or-sha>.tgz.sha256
```

### 2. 校验 SHA256

在 `artifacts/` 下校验，**失败则停止**，不得安装：

```bash
cd /opt/pidance/artifacts
sha256sum -c "pidance-<version-or-sha>.tgz.sha256"
```

或显式对比：

```bash
sha256sum "pidance-<version-or-sha>.tgz"
# 与 .sha256 文件中的哈希逐字一致
```

### 3. 安装到空 release 目录

**目标**：tgz 包自身与 production dependencies 均落入该 release 目录，且存在：

```text
/opt/pidance/releases/<version-or-sha>/node_modules/.bin/pidance
```

推荐步骤（`TGZ` 与上文 `artifacts/` 布局一致）：

```bash
VER="<version-or-sha>"
TGZ="/opt/pidance/artifacts/pidance-${VER}.tgz"
REL="/opt/pidance/releases/${VER}"

test -f "${TGZ}" || { echo "缺少制品: ${TGZ}" >&2; exit 1; }

mkdir -p "${REL}"
cd "${REL}"

# 空目录初始化，避免误用工作区 package.json
npm init -y

# 只装生产依赖；从本地 tgz 安装（勿用工作区路径冒充制品）
npm install --omit=dev --ignore-scripts "${TGZ}"
```

安装后结构要点：

| 路径 | 含义 |
|------|------|
| `node_modules/@henlii/pidance/` | 包根（含 `bin/`、`.next/` 等运行时文件） |
| `node_modules/.bin/pidance` | **稳定 CLI 入口**（systemd 应指向此绝对路径） |
| `node_modules/next/` 等 | production dependencies |

**不要**假定全局 `npm root -g` 或全局 `pidance`。正式服务**只**使用 `current` 下安装树中的 CLI。

CLI 实现基于 `__dirname` 定位包内 `.next`，并在包根作为 `next start` 的 cwd；因此 **systemd `WorkingDirectory` 设为 `/opt/pidance/current` 即可**，不必设为 `@henlii/pidance` 包根。

### 4. 切换 current

```bash
ln -sfn "/opt/pidance/releases/${VER}" /opt/pidance/current
# 确认
readlink -f /opt/pidance/current
test -x /opt/pidance/current/node_modules/.bin/pidance
```

### 5. 安装 systemd 单元

将仓库内 `deploy/pidance.service` 复制到：

```text
/etc/systemd/system/pidance.service
```

按本机 Node 稳定路径检查 unit 中 `PATH` / 可执行文件是否可达，然后：

```bash
systemctl daemon-reload
systemctl enable pidance.service
systemctl start pidance.service
systemctl status pidance.service --no-pager
```

**本说明文档不代替你执行上述命令。**

## 发布前后：证明未触碰上游 30141

在**任何**正式安装 / 重启 / 回滚 **之前与之后**，记录并对比（只读）：

```bash
# 监听与进程（示例；按本机 ss/lsof 可用性选用）
ss -lptn 'sport = :30141' || true
# 或
lsof -iTCP:30141 -sTCP:LISTEN || true

# 记录 PID（若有监听）
# BEFORE_PID=...  /  AFTER_PID=...
# 要求：PID 与监听状态相对发布操作无变化
```

同时确认 **31416** 持续测试服务（若存在）仍独立、未被本 unit 管理：

```bash
ss -lptn 'sport = :31416' || true
# 正式 unit 的 ExecStart 仅绑定 31415，且可执行文件名为 pidance
```

## 关键 HTTP 验收（正式版 31415）

服务 `active` 后，按 Issue #9 A2：下列路由**均须返回 HTTP 200**（任一路由非 200 即失败）：

```bash
# 进程与监听
systemctl is-active pidance.service
ss -lptn 'sport = :31415'

# A2 路由冒烟：/、/api/home、/api/about、/api/sessions、/api/models 均须 200
BASE="http://127.0.0.1:31415"
for path in / /api/home /api/about /api/sessions /api/models; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 "${BASE}${path}")
  if [ "${code}" != "200" ]; then
    echo "验收失败: ${path} -> HTTP ${code}（期望 200）" >&2
    exit 1
  fi
  echo "OK ${path} -> 200"
done

# CLI 身份：可执行 pidance，且无上游产品 bin
test -x /opt/pidance/current/node_modules/.bin/pidance
! test -e /opt/pidance/current/node_modules/.bin/pi-web
```

## 重启验收

```bash
systemctl restart pidance.service
systemctl is-active pidance.service

# 与关键 HTTP 验收相同的 A2 路由循环（均须 200）
BASE="http://127.0.0.1:31415"
for path in / /api/home /api/about /api/sessions /api/models; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 "${BASE}${path}")
  if [ "${code}" != "200" ]; then
    echo "重启验收失败: ${path} -> HTTP ${code}（期望 200）" >&2
    exit 1
  fi
  echo "OK ${path} -> 200"
done

# 再次确认 30141 监听/PID 未变；31416 未被本操作改动
```

## 回滚

1. 确认旧 release 目录仍完整：`/opt/pidance/releases/<old-ver>/node_modules/.bin/pidance`。
2. `ln -sfn /opt/pidance/releases/<old-ver> /opt/pidance/current`
3. `systemctl restart pidance.service`
4. 重复「关键 HTTP 验收」与「30141 未变化」记录。
5. **不要**用工作区 `npm run dev` 或 31416 进程顶替正式版。

## Nginx / 反代约束

1. 仅当 **31415** 上正式服务健康（systemd active + HTTP 冒烟通过）后，才将反代 upstream 切到 **31415**。
2. 反代**禁止**指向 31416（测试）、30141（上游 pi-web）、30143（待退役）。
3. 切换反代前后同样记录 30141 状态，证明未误操作上游。

## 日志

- 单元使用 journal（`StandardOutput=journal` / `StandardError=journal`）。
- 查看：`journalctl -u pidance.service -e --no-pager`
- **不要**把正式版日志写到工作区测试目录或上游产品日志路径。

## 清理约束

- 可删除确认无用的旧 `releases/<ver>`，**先**保证 `current` 不指向它们，且至少保留一个可回滚版本。
- **不要**删除 `artifacts/` 中与线上 current 对应的 tgz + sha256（审计与复现需要）。
- **不要**清理 `/root/.pi/agent`（Pi 会话数据）。
- **不要**停止或清理 30141 / 31416 相关进程与目录（除非运维另有明确、且与本产品无关的变更单）。
- 本仓库开发约束：开发期禁止 `next build` 污染工作区 `.next`；正式构建仅在隔离发布 checkout 中进行（与本机 `/opt` 安装无关）。

## 单元文件

见同目录 [`pidance.service`](./pidance.service)。复制到 `/etc/systemd/system/pidance.service` 后由 systemd 管理；**本目录不包含自动 enable/start 脚本**。

## 与发布门禁的关系（提醒）

正式 npm / GitHub Release 须使用**同一已验收 tgz + SHA256**；`npm publish` 成功不能替代本机正式安装验收与 HTTP 冒烟。任何脚本**不得自动** version / tag / push / publish / 创建 Release。本 `deploy/` 仅治理**安装侧**布局与 unit，不替代发布审计脚本。
