import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const roster = await jiti.import("./agent-roster.ts");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function agentMd({ name, description, model, tools, disabled }) {
  const lines = ["---", `name: ${name}`, `description: ${description}`];
  if (model) lines.push(`model: ${model}`);
  if (tools) lines.push(`tools: ${tools}`);
  if (disabled) lines.push("disabled: true");
  lines.push("---", "", `You are ${name}.`);
  return lines.join("\n");
}

function historyLine(i) {
  return JSON.stringify({
    agent: i % 2 === 0 ? "scout" : "designer",
    task: `task-${i}`,
    ts: 1000 + i,
    status: i === 3 ? "error" : "ok",
    duration: 10 + i,
    ...(i === 3 ? { exit: 1 } : {}),
  });
}

test("parseFrontmatter：简单键值与列表", () => {
  const { frontmatter, body } = roster.parseFrontmatter(
    "---\nname: scout\ndescription: Fast recon\ntools: read, grep\n---\n\nBody here\n",
  );
  assert.equal(frontmatter.name, "scout");
  assert.equal(frontmatter.description, "Fast recon");
  assert.equal(frontmatter.tools, "read, grep");
  assert.equal(body, "Body here");
});

test("parseAgentMarkdown：缺 name/description 跳过", () => {
  assert.equal(roster.parseAgentMarkdown("---\nname: x\n---\n", "user", "/a.md"), null);
  assert.equal(roster.parseAgentMarkdown("---\ndescription: only\n---\n", "user", "/a.md"), null);
  const ok = roster.parseAgentMarkdown(
    agentMd({ name: "scout", description: "Fast", model: "m1", tools: "read, grep" }),
    "builtin",
    "/tmp/scout.md",
  );
  assert.equal(ok.name, "scout");
  assert.equal(ok.source, "builtin");
  assert.equal(ok.model, "m1");
  assert.deepEqual(ok.tools, ["read", "grep"]);
});

test("parseRunHistoryLine：合法/损坏", () => {
  const ok = roster.parseRunHistoryLine(
    JSON.stringify({ agent: "scout", task: "find X", ts: 100, status: "ok", duration: 12 }),
  );
  assert.equal(ok.agent, "scout");
  assert.equal(ok.status, "ok");
  assert.equal(roster.parseRunHistoryLine("{"), null);
  assert.equal(roster.parseRunHistoryLine(JSON.stringify({ agent: "x" })), null);
  assert.equal(
    roster.parseRunHistoryLine(
      JSON.stringify({ agent: "a", task: "t", ts: 1, status: "nope", duration: 1 }),
    ),
    null,
  );
});

test("listAgentRoster：builtin/user/project + history 有界尾部", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-roster-"));
  try {
    const agentRoot = path.join(root, ".pi", "agent");
    const builtinDir = path.join(agentRoot, "npm", "node_modules", "pi-subagents", "agents");
    const userDir = path.join(agentRoot, "agents");
    const projectRoot = path.join(root, "proj");
    const projectAgents = path.join(projectRoot, ".pi", "agents");

    writeFile(
      path.join(builtinDir, "scout.md"),
      agentMd({ name: "scout", description: "Builtin scout", tools: "read" }),
    );
    writeFile(
      path.join(userDir, "designer.md"),
      agentMd({ name: "designer", description: "User designer", model: "kimi" }),
    );
    writeFile(
      path.join(projectAgents, "worker.md"),
      agentMd({ name: "worker", description: "Project worker" }),
    );
    // 无 name 的损坏文件应跳过
    writeFile(path.join(userDir, "broken.md"), "---\ndescription: only\n---\n");

    const historyLines = [];
    for (let i = 0; i < 5; i++) {
      historyLines.push(historyLine(i));
    }
    // 插入损坏行
    historyLines.splice(2, 0, "{not-json");
    writeFile(path.join(agentRoot, "run-history.jsonl"), historyLines.join("\n") + "\n");

    const snap = roster.listAgentRoster({
      cwd: projectRoot,
      env: { PI_CODING_AGENT_DIR: agentRoot },
      homedir: () => root,
      historyLimit: 3,
    });

    assert.equal(snap.agentRoot, path.resolve(agentRoot));
    const names = snap.agents.map((a) => `${a.source}:${a.name}`).sort();
    assert.deepEqual(names, ["builtin:scout", "project:worker", "user:designer"].sort());
    assert.equal(snap.counts.total, 3);
    assert.equal(snap.counts.bySource.builtin, 1);
    assert.equal(snap.counts.bySource.user, 1);
    assert.equal(snap.counts.bySource.project, 1);

    // 尾部 3 条有效（损坏行跳过，从末尾取）
    assert.equal(snap.historyAvailable, true);
    assert.equal(snap.history.length, 3);
    assert.equal(snap.history[0].task, "task-4");
    assert.equal(snap.history[1].task, "task-3");
    assert.equal(snap.history[1].status, "error");
    assert.equal(snap.history[1].exit, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listAgentRoster：无 cwd 时不含 project；history 缺失安全", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-roster-empty-"));
  try {
    const agentRoot = path.join(root, ".pi", "agent");
    fs.mkdirSync(agentRoot, { recursive: true });
    const snap = roster.listAgentRoster({
      cwd: null,
      env: { PI_CODING_AGENT_DIR: agentRoot },
      homedir: () => root,
      builtinDir: null,
    });
    assert.equal(snap.agents.length, 0);
    assert.equal(snap.historyAvailable, false);
    assert.deepEqual(snap.history, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parseHistoryLimit：默认/边界/非法", () => {
  assert.equal(roster.parseHistoryLimit(null), roster.DEFAULT_HISTORY_LIMIT);
  assert.equal(roster.parseHistoryLimit("10"), 10);
  assert.equal(roster.parseHistoryLimit("0"), null);
  assert.equal(roster.parseHistoryLimit("999"), null);
  assert.equal(roster.parseHistoryLimit("abc"), null);
});

test("symlink 文件被拒绝", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-roster-sym-"));
  try {
    const agentRoot = path.join(root, ".pi", "agent");
    const userDir = path.join(agentRoot, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    const real = path.join(root, "outside.md");
    writeFile(real, agentMd({ name: "evil", description: "should skip" }));
    fs.symlinkSync(real, path.join(userDir, "evil.md"));
    const snap = roster.listAgentRoster({
      env: { PI_CODING_AGENT_DIR: agentRoot },
      homedir: () => root,
      builtinDir: null,
    });
    assert.equal(snap.agents.find((a) => a.name === "evil"), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run-history >512KB：尾部读取最新条目（B1 回归）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-roster-big-"));
  try {
    const agentRoot = path.join(root, ".pi", "agent");
    fs.mkdirSync(agentRoot, { recursive: true });
    // 写入 >512KB 的 history：旧记录在头部，最新记录在尾部
    const count = 8000;
    const lines = [];
    for (let i = 0; i < count; i++) {
      lines.push(historyLine(i));
    }
    const filePath = path.join(agentRoot, "run-history.jsonl");
    writeFile(filePath, lines.join("\n") + "\n");
    const stat = fs.statSync(filePath);
    assert.ok(stat.size > roster.MAX_HISTORY_FILE_BYTES, "fixture 应超过 512KB");

    const snap = roster.listAgentRoster({
      env: { PI_CODING_AGENT_DIR: agentRoot },
      homedir: () => root,
      builtinDir: null,
      historyLimit: 3,
    });

    assert.equal(snap.historyAvailable, true);
    assert.equal(snap.history.length, 3);
    // 尾部：最新的是 count-1，然后 count-2、count-3
    assert.equal(snap.history[0].task, `task-${count - 1}`);
    assert.equal(snap.history[1].task, `task-${count - 2}`);
    assert.equal(snap.history[2].task, `task-${count - 3}`);
    // 绝不是头部最旧的
    assert.notEqual(snap.history[0].task, "task-0");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findNearestProjectRoot：仅 .agents 不算项目根（F2 回归）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-roster-home-"));
  try {
    // root 作为 home；root 下只有 .agents，没有 .git/.pi
    fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
    const someUserDir = path.join(root, "some-cwd");
    fs.mkdirSync(someUserDir, { recursive: true });
    const snap = roster.listAgentRoster({
      cwd: someUserDir,
      env: { PI_CODING_AGENT_DIR: path.join(root, ".pi", "agent") },
      homedir: () => root,
      builtinDir: null,
    });
    // 无 project Agents：someUserDir 不在 git 仓且未命中 .git/.pi
    assert.equal(snap.counts.total, 0);
    assert.equal(snap.counts.bySource.project, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
