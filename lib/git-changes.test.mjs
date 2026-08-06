import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

async function loadSubject() {
  return import("./git-status.ts");
}

/** git-changes.ts 含真实相对导入（file-types 等），需 jiti 解析。 */
const loadGitChanges = createJiti(import.meta.url);

test("parses null-delimited Git status entries including renames", async () => {
  const { parseGitPorcelainV1 } = await loadSubject();
  const entries = parseGitPorcelainV1([
    " M components/App.tsx",
    "?? notes.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.deepEqual(entries, [
    {
      path: "components/App.tsx",
      indexStatus: " ",
      worktreeStatus: "M",
    },
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
    },
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      indexStatus: "R",
      worktreeStatus: " ",
    },
  ]);
});

test("classifies Git status for explorer badges", async () => {
  const { classifyGitStatus } = await loadSubject();
  const classify = (pair) => classifyGitStatus({
    path: "file.ts",
    indexStatus: pair[0],
    worktreeStatus: pair[1],
  });

  assert.deepEqual(classify(" M"), { status: "modified", code: "M" });
  assert.deepEqual(classify("??"), { status: "untracked", code: "U" });
  assert.deepEqual(classify("A "), { status: "added", code: "A" });
  assert.deepEqual(classify("R "), { status: "renamed", code: "R" });
  assert.deepEqual(classify("UU"), { status: "conflict", code: "C" });
  assert.deepEqual(classify(" D"), { status: "deleted", code: "D" });
});

// ── git-changes 响应缓存语义（P1-6 HEAD 校验回归）──
//
// diff 缓存命中 = 文件 (mtimeMs, size) 与仓库 HEAD 均未变：
//   - 文件 mtime/size 变化 → 该文件 diff 定向失效（P1-3 语义保留）；
//   - HEAD 变化（分支切换 / reset / checkout）→ 即便工作树文件未变也
//     整体失效——diff 基线是 HEAD，基线变了缓存即过期。
// 命中返回缓存条目的同一 response 对象（引用相等），可用 === 区分命中与重算。

const GIT_ENV = {
  ...process.env,
  LC_ALL: "C",
  GIT_AUTHOR_NAME: "pidance-test",
  GIT_AUTHOR_EMAIL: "pidance-test@example.com",
  GIT_COMMITTER_NAME: "pidance-test",
  GIT_COMMITTER_EMAIL: "pidance-test@example.com",
};

function runGit(repoDir, ...args) {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

/** 建临时 git 仓库并提交初始文件；返回仓库目录（测试结束自动清理）。 */
function createRepo(t, files) {
  const repoDir = mkdtempSync(path.join(tmpdir(), "pidance-git-changes-"));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));
  runGit(repoDir, "init", "-q");
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(repoDir, name), content);
  }
  runGit(repoDir, "add", ".");
  runGit(repoDir, "commit", "-q", "-m", "initial");
  return repoDir;
}

function commitAll(repoDir, message) {
  runGit(repoDir, "add", ".");
  runGit(repoDir, "commit", "-q", "-m", message);
}

test("diff 缓存命中：文件与 HEAD 均未变时复用同一响应对象", async (t) => {
  const { getGitFileDiff } = await loadGitChanges("./git-changes.ts");
  const repoDir = createRepo(t, { "file.txt": "one\n" });
  const filePath = path.join(repoDir, "file.txt");
  writeFileSync(filePath, "one two\n");

  const first = await getGitFileDiff(repoDir, filePath);
  assert.equal(first.supported, true);
  assert.ok(first.patch.includes("+one two"));
  // 二次请求：mtime/size/HEAD 均未变 → 命中缓存 → 同一对象引用（非重算）。
  const second = await getGitFileDiff(repoDir, filePath);
  assert.equal(second, first);
});

test("HEAD 变化（reset --soft）但文件未变 → diff 缓存失效重抓", async (t) => {
  const { getGitFileDiff } = await loadGitChanges("./git-changes.ts");
  const repoDir = createRepo(t, { "file.txt": "v1\n" }); // C1
  writeFileSync(path.join(repoDir, "file.txt"), "v2\n");
  commitAll(repoDir, "second"); // C2：file.txt = v2
  const c2Sha = runGit(repoDir, "rev-parse", "HEAD");
  const c1Sha = runGit(repoDir, "rev-parse", "HEAD~1");
  runGit(repoDir, "reset", "--hard", c1Sha); // 工作树回到 v1
  const filePath = path.join(repoDir, "file.txt");
  writeFileSync(filePath, "v1-modified\n");

  const first = await getGitFileDiff(repoDir, filePath);
  assert.equal(first.supported, true);
  assert.ok(first.patch.includes("-v1")); // 基线 C1

  // HEAD 移到 C2，工作树文件未动（mtime/size 不变）——旧实现会命中旧缓存。
  runGit(repoDir, "reset", "--soft", c2Sha);
  const second = await getGitFileDiff(repoDir, filePath);
  assert.notEqual(second, first); // 必须重算，非缓存命中
  assert.ok(second.patch.includes("-v2")); // 新基线 C2
  assert.ok(!second.patch.includes("-v1"));
});

test("文件 mtime 变化（内容未变）→ diff 缓存定向失效重抓", async (t) => {
  const { getGitFileDiff } = await loadGitChanges("./git-changes.ts");
  const repoDir = createRepo(t, { "file.txt": "one\n" });
  const filePath = path.join(repoDir, "file.txt");
  writeFileSync(filePath, "one two\n");
  const first = await getGitFileDiff(repoDir, filePath);
  assert.ok(first.patch.includes("+one two"));

  // 仅推进 mtime，内容与 HEAD 均不变 → 定向失效 → 重算（新对象，内容一致）。
  utimesSync(filePath, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const second = await getGitFileDiff(repoDir, filePath);
  assert.notEqual(second, first);
  assert.equal(second.patch, first.patch);

  // mtime 已稳定 → 再次命中缓存。
  const third = await getGitFileDiff(repoDir, filePath);
  assert.equal(third, second);
});

test("HEAD 相同、文件内容变化 → diff 缓存失效返回新 patch", async (t) => {
  const { getGitFileDiff } = await loadGitChanges("./git-changes.ts");
  const repoDir = createRepo(t, { "file.txt": "one\n" });
  const filePath = path.join(repoDir, "file.txt");
  writeFileSync(filePath, "one two\n");
  const first = await getGitFileDiff(repoDir, filePath);
  assert.ok(first.patch.includes("+one two"));

  writeFileSync(filePath, "completely different\n");
  utimesSync(filePath, new Date(Date.now() + 6000), new Date(Date.now() + 6000));
  const second = await getGitFileDiff(repoDir, filePath);
  assert.notEqual(second, first);
  assert.ok(second.patch.includes("+completely different"));
  assert.ok(!second.patch.includes("+one two"));
});
