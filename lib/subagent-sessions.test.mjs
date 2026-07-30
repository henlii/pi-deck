import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  discoverSubagentSessions,
  collectSubagentTree,
  deleteValidatedSubagents,
  SUBAGENT_DISCOVERY_LIMITS,
} = await jiti.import("./subagent-sessions.ts");

const header = (id) => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/tmp" });
async function child(root, id, index, parentId) {
  await mkdir(join(root, `${parentId}`, "12345678", `run-${index}`), { recursive: true });
  const path = join(root, `${parentId}`, "12345678", `run-${index}`, "session.jsonl");
  await writeFile(path, `${header(id)}\n`, "utf8");
  return path;
}

function toolResult(results, details = {}) {
  return JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { ...details, results } } });
}

async function metadataChild(root, parentId, id, index, runId = "12345678") {
  const path = join(root, parentId, runId, `run-${index}`, "session.jsonl");
  await mkdir(join(root, parentId, runId, `run-${index}`), { recursive: true });
  await writeFile(path, `${header(id)}\n`, "utf8");
  return path;
}

test("只发现严格布局的直接子代理并递归挂接孙代理", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    await writeFile(parent, `${header("parent")}\n`, "utf8");
    const first = await child(root, "child", 2, "parent");
    const childRoot = first.slice(0, -"/session.jsonl".length);
    const nestedParent = join(childRoot, "session.jsonl");
    const grandRoot = join(childRoot, "session");
    await writeFile(nestedParent, `${header("child")}\n${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { results: [{ sessionFile: join(grandRoot, "87654321", "run-0", "session.jsonl") }] } } })}\n`, "utf8");
    await mkdir(join(grandRoot, "87654321", "run-0"), { recursive: true });
    await writeFile(join(grandRoot, "87654321", "run-0", "session.jsonl"), `${header("grand")}\n`, "utf8");
    await writeFile(parent, `${header("parent")}\n${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { results: [{ sessionFile: first }] } } })}\n`, "utf8");
    assert.deepEqual(collectSubagentTree(parent, "parent").map((x) => x.header.id), ["child", "grand"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("路径越界、symlink 和损坏 header 安全忽略", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    await writeFile(parent, `${header("parent")}\n`, "utf8");
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, `${header("outside")}\n`, "utf8");
    await mkdir(join(root, "parent", "12345678", "run-0"), { recursive: true });
    await symlink(outside, join(root, "parent", "12345678", "run-0", "session.jsonl"));
    await writeFile(parent, `${header("parent")}\n${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { results: [{ sessionFile: outside }] } } })}\n`, "utf8");
    assert.equal(discoverSubagentSessions(parent, "parent").length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("并行 child 使用物理 run-N，管理空结果和缺失 sessionFile 会忽略", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    const one = await metadataChild(root, "parent", "one", 7);
    const two = await metadataChild(root, "parent", "two", 1, "abcdef12");
    await writeFile(parent, `${header("parent")}\n${toolResult([])}\n${toolResult([{ nope: true }, { sessionFile: one }])}\n${toolResult([{ sessionFile: two }])}\n`, "utf8");
    const found = discoverSubagentSessions(parent, "parent");
    assert.deepEqual(found.map((x) => [x.header.id, x.runIndex]), [["one", 7], ["two", 1]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("损坏 metadata 回退严格扫描，普通 fork 不会伪装 subagent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    const path = await metadataChild(root, "parent", "fallback", 0);
    await writeFile(parent, `${header("parent")}\nnot-json\n`, "utf8");
    assert.equal(discoverSubagentSessions(parent, "parent")[0].header.id, "fallback");
    await writeFile(join(root, "fork.jsonl"), `${JSON.stringify({ ...JSON.parse(header("fork")), parentSession: parent })}\n`, "utf8");
    assert.equal(discoverSubagentSessions(join(root, "fork.jsonl"), "fork").length, 0);
    assert.match(path, /run-0[\\/]session\.jsonl$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("重复 path/id、跨父根 id 和祖先循环只保留安全直接关系", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    const other = join(root, "other.jsonl");
    const same = await metadataChild(root, "parent", "same", 0);
    await writeFile(parent, `${header("parent")}\n${toolResult([{ sessionFile: same }, { sessionFile: same }])}\n`, "utf8");
    await writeFile(other, `${header("other")}\n${toolResult([{ sessionFile: same }])}\n`, "utf8");
    assert.equal(discoverSubagentSessions(parent, "parent").length, 1);
    assert.equal(discoverSubagentSessions(other, "other").length, 0);
    await writeFile(same, `${JSON.stringify({ ...JSON.parse(header("parent")), parentSession: parent })}\n`, "utf8");
    assert.equal(collectSubagentTree(parent, "parent").length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("删除 helper 只删除再次验证的 child，保留未知文件和 symlink，并统计跳过", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parentRoot = join(root, "parent");
    const valid = await metadataChild(root, "parent", "valid", 0);
    const changed = await metadataChild(root, "parent", "changed", 1);
    const unknown = join(root, "parent", "12345678", "unknown.txt");
    await writeFile(unknown, "keep", "utf8");
    await writeFile(changed, `${header("other")}\n`, "utf8");
    const invalidated = [];
    const children = [{ path: valid, header: JSON.parse(header("valid")), runIndex: 0, parentSessionId: "parent", runId: "12345678" }, { path: changed, header: JSON.parse(header("changed")), runIndex: 1, parentSessionId: "parent", runId: "12345678" }];
    const skipped = deleteValidatedSubagents(children, parentRoot, (id) => invalidated.push(id));
    assert.equal(skipped, 1);
    assert.deepEqual(invalidated, ["valid"]);
    await mkdir(join(root, "parent", "12345678", "run-0"), { recursive: true });
    await writeFile(valid, `${header("valid")}\n`, "utf8");
    const link = join(root, "parent", "abcdef12", "run-2", "session.jsonl");
    await mkdir(join(root, "parent", "abcdef12", "run-2"), { recursive: true });
    await symlink(valid, link);
    const skippedLink = deleteValidatedSubagents([{ ...children[0], path: link }], parentRoot, () => {});
    assert.equal(skippedLink, 1);
    await access(unknown);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("发现上限公开为测试可验证的固定边界", () => {
  assert.equal(SUBAGENT_DISCOVERY_LIMITS.maxChildren, 256);
  assert.equal(SUBAGENT_DISCOVERY_LIMITS.maxDepth, 16);
  assert.equal(SUBAGENT_DISCOVERY_LIMITS.maxScanEntries, 2048);
  assert.equal(SUBAGENT_DISCOVERY_LIMITS.maxMetadataCandidates, 512);
});
