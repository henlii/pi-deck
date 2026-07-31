/**
 * Hermes 记忆只读后端定向测试。
 * 不触碰本机 ~/.pi/agent 真实记忆。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

/** @returns {Promise<typeof import("./hermes-memory.ts")>} */
async function load() {
  return jiti.import("./hermes-memory.ts");
}

const DELIM = "\n§\n";

/**
 * @param {string} root
 * @param {Record<string, string>} files relative path -> content
 */
function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
}

/**
 * @param {string} dir
 * @returns {Record<string, { mtimeMs: number; size: number }>}
 */
function snapshotFiles(dir) {
  /** @type {Record<string, { mtimeMs: number; size: number }>} */
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isFile()) out[name] = { mtimeMs: st.mtimeMs, size: st.size };
  }
  return out;
}

test("拆分 MEMORY/USER/failures 条目", async () => {
  const {
    ENTRY_DELIMITER,
    splitMemoryEntries,
    readHermesMemory,
  } = await load();
  assert.equal(ENTRY_DELIMITER, DELIM);

  const entries = splitMemoryEntries(
    `first fact${DELIM}second fact${DELIM}  third  `,
  );
  assert.deepEqual(
    entries.map((e) => e.text),
    ["first fact", "second fact", "third"],
  );
  assert.ok(entries.every((e) => e.sensitive === false));

  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hm-split-"));
  try {
    writeTree(agentRoot, {
      "pi-hermes-memory/MEMORY.md": `m1${DELIM}m2`,
      "pi-hermes-memory/USER.md": `u1${DELIM}u2${DELIM}u3`,
      "pi-hermes-memory/failures.md": `f1`,
    });
    const snap = readHermesMemory({
      agentRoot,
      cwd: null,
      homedir: () => "/home/testuser",
    });
    assert.equal(snap.agentRoot, agentRoot);
    assert.equal(snap.globalDir, path.join(agentRoot, "pi-hermes-memory"));
    assert.deepEqual(
      snap.global.memory.entries.map((e) => e.text),
      ["m1", "m2"],
    );
    assert.deepEqual(
      snap.global.user.entries.map((e) => e.text),
      ["u1", "u2", "u3"],
    );
    assert.deepEqual(
      snap.global.failures.entries.map((e) => e.text),
      ["f1"],
    );
    assert.equal(snap.global.memory.exists, true);
    assert.equal(snap.project, null);
  } finally {
    fs.rmSync(agentRoot, { recursive: true, force: true });
  }
});

test("basename(cwd) 映射到 projects-memory", async () => {
  const { readHermesMemory, resolveProjectName } = await load();
  assert.equal(resolveProjectName("/work/my-repo", { homedir: () => "/home/u" }), "my-repo");
  assert.equal(resolveProjectName("/work/my-repo/", { homedir: () => "/home/u" }), "my-repo");

  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hm-proj-"));
  try {
    writeTree(agentRoot, {
      "pi-hermes-memory/MEMORY.md": "global-only",
      "projects-memory/pidance/MEMORY.md": `proj-a${DELIM}proj-b`,
    });
    const snap = readHermesMemory({
      agentRoot,
      cwd: "/somewhere/pidance",
      homedir: () => "/home/u",
    });
    assert.ok(snap.project);
    assert.equal(snap.project.name, "pidance");
    assert.equal(
      snap.project.dir,
      path.join(agentRoot, "projects-memory", "pidance"),
    );
    assert.deepEqual(
      snap.project.memory.entries.map((e) => e.text),
      ["proj-a", "proj-b"],
    );
    assert.equal(snap.project.memory.exists, true);
    assert.deepEqual(
      snap.global.memory.entries.map((e) => e.text),
      ["global-only"],
    );
  } finally {
    fs.rmSync(agentRoot, { recursive: true, force: true });
  }
});

test("home cwd → 无项目", async () => {
  const { readHermesMemory, resolveProjectName } = await load();
  const home = "/home/alice";
  assert.equal(resolveProjectName(home, { homedir: () => home }), null);
  assert.equal(resolveProjectName("/", { homedir: () => home }), null);
  assert.equal(resolveProjectName("", { homedir: () => home }), null);
  assert.equal(resolveProjectName(null, { homedir: () => home }), null);

  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hm-home-"));
  try {
    writeTree(agentRoot, {
      "pi-hermes-memory/MEMORY.md": "g",
      "projects-memory/alice/MEMORY.md": "should-not-load",
    });
    const snap = readHermesMemory({
      agentRoot,
      cwd: home,
      homedir: () => home,
    });
    assert.equal(snap.project, null);
  } finally {
    fs.rmSync(agentRoot, { recursive: true, force: true });
  }
});

test("symlink/越界拒绝", async () => {
  const { readMemorySection, readHermesMemory } = await load();
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hm-sym-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hm-out-"));
  try {
    const secretPath = path.join(outside, "secret.txt");
    fs.writeFileSync(secretPath, "leaked-secret-data", "utf8");

    const globalDir = path.join(agentRoot, "pi-hermes-memory");
    fs.mkdirSync(globalDir, { recursive: true });
    const linkPath = path.join(globalDir, "MEMORY.md");
    fs.symlinkSync(secretPath, linkPath);

    const section = readMemorySection(linkPath, globalDir);
    assert.equal(section.entries.length, 0);
    assert.ok(section.error, "symlink 应带 error");
    assert.match(section.error, /符号链接|安全检查/);

    // 越界：允许根外的绝对路径
    const outsideSection = readMemorySection(secretPath, globalDir, {
      allowedNames: ["secret.txt"],
    });
    // 非白名单名或越界
    assert.equal(outsideSection.entries.length, 0);

    const snap = readHermesMemory({
      agentRoot,
      cwd: "/work/x",
      homedir: () => "/home/u",
    });
    assert.equal(snap.global.memory.entries.length, 0);
    assert.ok(snap.global.memory.error);
  } finally {
    fs.rmSync(agentRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("超大文件 truncated", async () => {
  const { readMemorySection, MAX_MEMORY_FILE_BYTES } = await load();
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hm-big-"));
  try {
    const globalDir = path.join(agentRoot, "pi-hermes-memory");
    fs.mkdirSync(globalDir, { recursive: true });
    const filePath = path.join(globalDir, "MEMORY.md");
    // 构造超过限制：entry1 + delim + 大块
    const big = "A".repeat(MAX_MEMORY_FILE_BYTES + 1024);
    const content = `small-entry${DELIM}${big}`;
    fs.writeFileSync(filePath, content, "utf8");

    const section = readMemorySection(filePath, globalDir, {
      maxBytes: MAX_MEMORY_FILE_BYTES,
    });
    assert.equal(section.exists, true);
    assert.equal(section.truncated, true);
    assert.ok(section.size != null && section.size > MAX_MEMORY_FILE_BYTES);
    // 已读内容仍尽量拆分
    assert.ok(section.entries.length >= 1);
    assert.equal(section.entries[0].text, "small-entry");
  } finally {
    fs.rmSync(agentRoot, { recursive: true, force: true });
  }
});

test("密钥样例 sensitive=true", async () => {
  const { splitMemoryEntries, scanSecrets } = await load();
  const withKey = "api key is sk-ant-api0123456789abcdef";
  const ids = scanSecrets(withKey);
  assert.ok(ids.includes("anthropic_api_key"));

  const entries = splitMemoryEntries(
    `safe note${DELIM}${withKey}${DELIM}password = hunter22`,
  );
  assert.equal(entries.length, 3);
  assert.equal(entries[0].sensitive, false);
  assert.equal(entries[1].sensitive, true);
  assert.ok(entries[1].sensitiveIds.includes("anthropic_api_key"));
  assert.equal(entries[2].sensitive, true);
  assert.ok(entries[2].sensitiveIds.includes("password_assignment"));
});

test("读取前后 fixture mtime/size 不变", async () => {
  const { readHermesMemory } = await load();
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hm-mtime-"));
  try {
    const globalDir = path.join(agentRoot, "pi-hermes-memory");
    writeTree(agentRoot, {
      "pi-hermes-memory/MEMORY.md": `a${DELIM}b`,
      "pi-hermes-memory/USER.md": "user",
      "pi-hermes-memory/failures.md": "fail",
      "projects-memory/demo/MEMORY.md": "proj",
    });
    // 固定 mtime
    const t = new Date("2024-01-15T12:00:00Z");
    for (const rel of [
      "pi-hermes-memory/MEMORY.md",
      "pi-hermes-memory/USER.md",
      "pi-hermes-memory/failures.md",
      "projects-memory/demo/MEMORY.md",
    ]) {
      fs.utimesSync(path.join(agentRoot, rel), t, t);
    }

    const beforeGlobal = snapshotFiles(globalDir);
    const beforeProj = snapshotFiles(path.join(agentRoot, "projects-memory", "demo"));

    const snap = readHermesMemory({
      agentRoot,
      cwd: "/tmp/demo",
      homedir: () => "/home/u",
    });
    assert.equal(snap.global.memory.entries.length, 2);
    assert.ok(snap.project);

    const afterGlobal = snapshotFiles(globalDir);
    const afterProj = snapshotFiles(path.join(agentRoot, "projects-memory", "demo"));
    assert.deepEqual(afterGlobal, beforeGlobal);
    assert.deepEqual(afterProj, beforeProj);
  } finally {
    fs.rmSync(agentRoot, { recursive: true, force: true });
  }
});

test("缺失文件优雅", async () => {
  const { readHermesMemory, readMemorySection } = await load();
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hm-miss-"));
  try {
    // 完全空的 agent root
    const snap = readHermesMemory({
      agentRoot,
      cwd: "/work/missing-proj",
      homedir: () => "/home/u",
    });
    assert.equal(snap.global.memory.exists, false);
    assert.equal(snap.global.user.exists, false);
    assert.equal(snap.global.failures.exists, false);
    assert.deepEqual(snap.global.memory.entries, []);
    assert.ok(snap.project);
    assert.equal(snap.project.name, "missing-proj");
    assert.equal(snap.project.memory.exists, false);
    assert.deepEqual(snap.project.memory.entries, []);
    assert.equal(snap.global.memory.error, undefined);

    // 空文件
    const globalDir = path.join(agentRoot, "pi-hermes-memory");
    fs.mkdirSync(globalDir, { recursive: true });
    const emptyPath = path.join(globalDir, "MEMORY.md");
    fs.writeFileSync(emptyPath, "", "utf8");
    const empty = readMemorySection(emptyPath, globalDir);
    assert.equal(empty.exists, true);
    assert.deepEqual(empty.entries, []);
    assert.equal(empty.truncated, false);
    assert.equal(empty.size, 0);
  } finally {
    fs.rmSync(agentRoot, { recursive: true, force: true });
  }
});

test("resolveAgentRoot 尊重 PI_CODING_AGENT_DIR", async () => {
  const { resolveAgentRoot } = await load();
  assert.equal(
    resolveAgentRoot({
      env: { PI_CODING_AGENT_DIR: "/custom/agent" },
      homedir: () => "/home/u",
    }),
    path.resolve("/custom/agent"),
  );
  assert.equal(
    resolveAgentRoot({
      env: {},
      homedir: () => "/home/u",
    }),
    path.join("/home/u", ".pi", "agent"),
  );
  assert.equal(
    resolveAgentRoot({
      env: { PI_CODING_AGENT_DIR: "~/my-agent" },
      homedir: () => "/home/u",
    }),
    path.join("/home/u", "my-agent"),
  );
});

test("非白名单文件名拒绝", async () => {
  const { readMemorySection } = await load();
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hm-wl-"));
  try {
    const globalDir = path.join(agentRoot, "pi-hermes-memory");
    fs.mkdirSync(globalDir, { recursive: true });
    const bad = path.join(globalDir, "sessions.db");
    fs.writeFileSync(bad, "should-not-read", "utf8");
    const section = readMemorySection(bad, globalDir);
    assert.equal(section.entries.length, 0);
    assert.ok(section.error);
    assert.match(section.error, /白名单/);
  } finally {
    fs.rmSync(agentRoot, { recursive: true, force: true });
  }
});
