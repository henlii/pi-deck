import assert from "node:assert/strict";
import test from "node:test";

// P1-4 Git base branch 解析测试：
// 纯解析函数 + resolveBaseBranch 主流程（fake git runner 覆盖全部候选分支，
// 不依赖真实 git 环境）。

async function loadSubject() {
  return import("./git-base-branch.ts");
}

/** 构造 fake git runner：按 args 精确匹配返回值，未注册命令抛错（验证未调用）。 */
function makeRunner(script) {
  return async (_cwd, args) => {
    const key = args.join(" ");
    const entry = script[key];
    if (!entry) throw new Error(`unexpected git call: git ${key}`);
    if (entry.error) throw new Error(entry.error);
    return entry.stdout;
  };
}

test("parseSymbolicRemoteHead：精确剥离 remote 前缀，不误判嵌套分支", async () => {
  const { parseSymbolicRemoteHead } = await loadSubject();
  assert.equal(parseSymbolicRemoteHead("refs/remotes/origin/main\n", "origin"), "main");
  // origin/feature/main 不能误判为 main——嵌套分支名完整保留。
  assert.equal(parseSymbolicRemoteHead("refs/remotes/origin/feature/main\n", "origin"), "feature/main");
  // remote 前缀不匹配 → null。
  assert.equal(parseSymbolicRemoteHead("refs/remotes/upstream/master\n", "origin"), null);
  // 空输出 / detached 裸 HEAD → null。
  assert.equal(parseSymbolicRemoteHead("", "origin"), null);
  assert.equal(parseSymbolicRemoteHead("HEAD\n", "origin"), null);
});

test("parseLsRemoteSymrefHead：解析远程 symbolic HEAD 行", async () => {
  const { parseLsRemoteSymrefHead } = await loadSubject();
  assert.equal(parseLsRemoteSymrefHead("ref: refs/heads/main HEAD\n"), "main");
  assert.equal(parseLsRemoteSymrefHead("ref: refs/heads/feature/main HEAD\n"), "feature/main");
  assert.equal(parseLsRemoteSymrefHead("refs/remotes/origin/main\n"), null);
  assert.equal(parseLsRemoteSymrefHead(""), null);
});

test("parseRemoteShowHeadBranch：解析 HEAD branch 行", async () => {
  const { parseRemoteShowHeadBranch } = await loadSubject();
  assert.equal(parseRemoteShowHeadBranch("  HEAD branch: main\n"), "main");
  assert.equal(parseRemoteShowHeadBranch("  HEAD branch: (remote) feature/x\n"), "feature/x");
  assert.equal(parseRemoteShowHeadBranch("  HEAD branch: (unknown)\n"), null);
  assert.equal(parseRemoteShowHeadBranch(""), null);
});

test("候选 1：本地 remote-tracking HEAD（offline 最高优先）", async () => {
  const { resolveBaseBranch } = await loadSubject();
  const runner = makeRunner({
    "rev-parse --abbrev-ref HEAD": { stdout: "dev\n" },
    "remote": { stdout: "origin\n" },
    "config --get branch.dev.remote": { error: "no upstream" },
    "symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/main\n" },
  });
  const info = await resolveBaseBranch("/repo", { runGit: runner, allowNetwork: false });
  assert.deepEqual(info, { branch: "main", source: "remote-symref-head", currentBranch: "dev" });
});

test("offline：候选 1 失败时不调用网络命令，直接走本地 main/master", async () => {
  const { resolveBaseBranch } = await loadSubject();
  const runner = makeRunner({
    "rev-parse --abbrev-ref HEAD": { stdout: "dev\n" },
    "remote": { stdout: "origin\n" },
    "config --get branch.dev.remote": { error: "no upstream" },
    "symbolic-ref refs/remotes/origin/HEAD": { error: "ref not found" },
    // allowNetwork: false 时 ls-remote / remote show 均不应被调用（未注册 → 抛错）。
    "rev-parse --verify --quiet refs/heads/main": { stdout: "" },
  });
  const info = await resolveBaseBranch("/repo", { runGit: runner, allowNetwork: false });
  assert.deepEqual(info, { branch: "main", source: "local-main", currentBranch: "dev" });
});

test("候选 2：ls-remote --symref（remote 非 origin）", async () => {
  const { resolveBaseBranch } = await loadSubject();
  const runner = makeRunner({
    "rev-parse --abbrev-ref HEAD": { stdout: "dev\n" },
    "remote": { stdout: "upstream\norigin\n" },
    "config --get branch.dev.remote": { stdout: "upstream\n" },
    "symbolic-ref refs/remotes/upstream/HEAD": { error: "ref not found" },
    "ls-remote --symref upstream HEAD": { stdout: "ref: refs/heads/trunk HEAD\n" },
  });
  const info = await resolveBaseBranch("/repo", { runGit: runner });
  assert.deepEqual(info, { branch: "trunk", source: "ls-remote-symref", currentBranch: "dev" });
});

test("候选 3：remote show 默认分支（offline 失败跳过）", async () => {
  const { resolveBaseBranch } = await loadSubject();
  const runner = makeRunner({
    "rev-parse --abbrev-ref HEAD": { stdout: "dev\n" },
    "remote": { stdout: "origin\n" },
    "config --get branch.dev.remote": { error: "no upstream" },
    "symbolic-ref refs/remotes/origin/HEAD": { error: "ref not found" },
    "ls-remote --symref origin HEAD": { error: "offline" },
    "remote show origin": { stdout: "  HEAD branch: develop\n" },
  });
  const info = await resolveBaseBranch("/repo", { runGit: runner });
  assert.deepEqual(info, { branch: "develop", source: "remote-show", currentBranch: "dev" });
});

test("多 remote：优先当前分支 upstream，不硬编码 origin", async () => {
  const { resolveBaseBranch } = await loadSubject();
  const runner = makeRunner({
    "rev-parse --abbrev-ref HEAD": { stdout: "feature/x\n" },
    "remote": { stdout: "upstream\norigin\n" },
    "config --get branch.feature/x.remote": { stdout: "upstream\n" },
    "symbolic-ref refs/remotes/upstream/HEAD": { stdout: "refs/remotes/upstream/main\n" },
  });
  const info = await resolveBaseBranch("/repo", { runGit: runner });
  assert.deepEqual(info, { branch: "main", source: "remote-symref-head", currentBranch: "feature/x" });
});

test("当前分支在默认分支上：返回 currentBranch 供消费方跳过自身 diff", async () => {
  const { resolveBaseBranch } = await loadSubject();
  const runner = makeRunner({
    "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
    "remote": { stdout: "origin\n" },
    "config --get branch.main.remote": { stdout: "origin\n" },
    "symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/main\n" },
  });
  const info = await resolveBaseBranch("/repo", { runGit: runner });
  // branch === currentBranch：消费方应判定「无需与 base diff」。
  assert.equal(info.branch, "main");
  assert.equal(info.currentBranch, "main");
});

test("候选 4/5：本地可解析的 main / master", async () => {
  const { resolveBaseBranch } = await loadSubject();
  const runnerMain = makeRunner({
    "rev-parse --abbrev-ref HEAD": { stdout: "dev\n" },
    "remote": { stdout: "" },
    "symbolic-ref": undefined,
    "rev-parse --verify --quiet refs/heads/main": { stdout: "" },
  });
  const infoMain = await resolveBaseBranch("/repo", { runGit: runnerMain });
  assert.deepEqual(infoMain, { branch: "main", source: "local-main", currentBranch: "dev" });

  const runnerMaster = makeRunner({
    "rev-parse --abbrev-ref HEAD": { stdout: "dev\n" },
    "remote": { stdout: "" },
    "rev-parse --verify --quiet refs/heads/main": { error: "no main" },
    "rev-parse --verify --quiet refs/heads/master": { stdout: "" },
  });
  const infoMaster = await resolveBaseBranch("/repo", { runGit: runnerMaster });
  assert.deepEqual(infoMaster, { branch: "master", source: "local-master", currentBranch: "dev" });
});

test("候选 6：无可靠结果返回 null，不伪造分支", async () => {
  const { resolveBaseBranch } = await loadSubject();
  const runner = makeRunner({
    "rev-parse --abbrev-ref HEAD": { stdout: "dev\n" },
    "remote": { stdout: "" },
    "rev-parse --verify --quiet refs/heads/main": { error: "no main" },
    "rev-parse --verify --quiet refs/heads/master": { error: "no master" },
  });
  const info = await resolveBaseBranch("/repo", { runGit: runner });
  assert.deepEqual(info, { branch: null, source: null, currentBranch: "dev" });
});

test("非 git 目录：直接返回空结构", async () => {
  const { resolveBaseBranch } = await loadSubject();
  const runner = makeRunner({
    "rev-parse --abbrev-ref HEAD": { error: "not a git repository" },
  });
  const info = await resolveBaseBranch("/plain", { runGit: runner });
  assert.deepEqual(info, { branch: null, source: null, currentBranch: null });
});

test("detached HEAD：currentBranch 为 null，仍继续解析 base", async () => {
  const { resolveBaseBranch } = await loadSubject();
  const runner = makeRunner({
    "rev-parse --abbrev-ref HEAD": { stdout: "HEAD\n" },
    "remote": { stdout: "origin\n" },
    "symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/main\n" },
  });
  const info = await resolveBaseBranch("/repo", { runGit: runner });
  assert.deepEqual(info, { branch: "main", source: "remote-symref-head", currentBranch: null });
});

test("显式 remote 参数优先于 upstream/origin", async () => {
  const { resolveBaseBranch } = await loadSubject();
  const runner = makeRunner({
    "rev-parse --abbrev-ref HEAD": { stdout: "dev\n" },
    "remote": { stdout: "a\nb\n" },
    "config --get branch.dev.remote": { stdout: "a\n" },
    "symbolic-ref refs/remotes/b/HEAD": { stdout: "refs/remotes/b/trunk\n" },
  });
  const info = await resolveBaseBranch("/repo", { runGit: runner, remote: "b" });
  assert.deepEqual(info, { branch: "trunk", source: "remote-symref-head", currentBranch: "dev" });
});
