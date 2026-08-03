/**
 * P5 无剪枝行为证据：分支/树导航只改变 leaf/context，原始 jsonl entry 全部保留。
 *
 * 验证层次说明（按所用层次如实报告）：
 * 1. 动态（真实 SessionManager，同 rpc-manager.test.mjs 的 A6 fixture）：
 *    branch()/leaf 切换前后 getEntries() 与原始 jsonl 内容只增不减，仅 leaf/context 投影变化。
 * 2. 动态（AgentSessionWrapper + 真实 SessionManager）：retract_message / restore_message
 *    只经 this.inner.navigateTree（树导航）移动 leaf，不调用任何删除/重写命令、不依赖 Dock。
 * 3. 静态（源码文本）：恢复旁支走 select_leaf_exact / navigate_tree 的契约存在，
 *    文件层原语是 sessionManager.branch()（无物理删除入口）。
 *
 * 注：SDK 的 SessionManager 可直接在 node:test 中构造（tmpdir，不碰 ~/.pi/agent），
 * 因此未降级到 session-reader 纯投影层。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);

/** 追加一条 user 消息。 */
function appendUser(sm, content) {
  return sm.appendMessage({ role: "user", content, timestamp: Date.now() });
}

/** 追加一条 assistant 消息（带完整 usage，匹配 SDK 形状）。 */
function appendAssistant(sm, text) {
  return sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "model-a",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

/** 从 jsonl 文件提取全部 message entry 的 id（保持文件顺序；损坏行跳过）。 */
function listMessageIds(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  const ids = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && typeof entry.id === "string") ids.push(entry.id);
    } catch {
      // 跳过损坏/半写行
    }
  }
  return ids;
}

/**
 * 注册 wrapper 清理：idle timer / 撤回栈必须在 finally 释放，否则 node:test 句柄不退出。
 * @param {import("node:test").TestContext} t
 * @param {{ destroy: () => void }} wrapper
 */
function trackWrapper(t, wrapper) {
  t.after(() => {
    try {
      wrapper.destroy();
    } catch {
      // destroy 幂等；清理阶段吞掉二次销毁噪音
    }
  });
  return wrapper;
}

test("分支/树导航只改 leaf/context：entries 与原始 jsonl 全部保留（不物理删除）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-noprune-branch-"));
  try {
    const sm = SessionManager.create(dir, dir);
    sm.appendModelChange("test", "model-a");
    const u1 = appendUser(sm, "第一个问题");
    const a1 = appendAssistant(sm, "回答一");
    const u2 = appendUser(sm, "第二个问题");
    const a2 = appendAssistant(sm, "回答二");
    assert.equal(sm.getLeafId(), a2);

    const file = sm.getSessionFile();
    assert.ok(file);
    assert.equal(sm.isPersisted(), true);

    const messageIds = () => listMessageIds(file);
    const entriesCount = () => sm.getEntries().length;

    // 主链基线：root→leaf 路径 + 文件内容（getBranch 含 model_change 等非消息条目，取消息投影）
    const branchMessageIds = (entryId) =>
      sm.getBranch(entryId).filter((e) => e.type === "message").map((e) => e.id);
    assert.deepEqual(branchMessageIds(a2), [u1, a1, u2, a2]);
    const baselineEntries = entriesCount();
    const baselineMessages = messageIds();
    assert.equal(baselineMessages.length, 4);

    // 从 u2 开出旁支（navigate_tree / select_leaf_exact 的文件层原语）
    sm.branch(u2);
    const u3 = appendUser(sm, "旁支问题");
    const a3 = appendAssistant(sm, "旁支回答");

    // leaf/context 变化：旁支路径进入投影
    assert.equal(sm.getLeafId(), a3);
    assert.deepEqual(branchMessageIds(a3), [u1, a1, u2, u3, a3]);
    // entries 与原始 jsonl 只增不减：主链 4 条 + 旁支 2 条，无任何删除
    assert.equal(entriesCount(), baselineEntries + 2);
    assert.deepEqual(messageIds(), [...baselineMessages, u3, a3]);

    // 切回主链（恢复动作 = 树导航）：leaf 回 a2，context 回主链，entries 仍全保留
    sm.branch(a2);
    assert.equal(sm.getLeafId(), a2);
    assert.deepEqual(branchMessageIds(a2), [u1, a1, u2, a2]);
    assert.equal(entriesCount(), baselineEntries + 2);
    assert.deepEqual(messageIds(), [...baselineMessages, u3, a3]);

    // 再切回旁支末端（restore 等价语义）：仍无任何删除
    sm.branch(a3);
    assert.equal(sm.getLeafId(), a3);
    assert.equal(entriesCount(), baselineEntries + 2);
    assert.deepEqual(messageIds(), [...baselineMessages, u3, a3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retract/restore 仅经 navigateTree 移动 leaf：jsonl 全量保留、无 Dock 依赖", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-noprune-retract-"));
  try {
    const sm = SessionManager.create(dir, dir);
    sm.appendModelChange("test", "model-a");
    const u1 = appendUser(sm, "问题一");
    const a1 = appendAssistant(sm, "回答一");
    const u2 = appendUser(sm, "问题二");
    const a2 = appendAssistant(sm, "回答二");
    // 旁支：u2 → u3 → a3
    sm.branch(u2);
    const u3 = appendUser(sm, "旁支问题");
    const a3 = appendAssistant(sm, "旁支回答");

    const sessionId = sm.getSessionId();
    const file = sm.getSessionFile();
    const entriesCount = () => sm.getEntries().length;
    const messageIds = () => listMessageIds(file);

    /** @type {Array<{ targetId: string, opts: unknown }>} */
    const navCalls = [];
    const inner = {
      sessionId,
      sessionManager: sm,
      isBashRunning: false,
      navigateTree: async (targetId, opts) => {
        // 镜像 SDK 树导航的文件层语义：只移动 leaf，不删除任何 entry
        navCalls.push({ targetId, opts });
        sm.branch(targetId);
        return { cancelled: false };
      },
    };
    const wrapper = trackWrapper(t, new AgentSessionWrapper(inner));

    const baseline = entriesCount();
    const baselineMessages = messageIds();
    assert.equal(baselineMessages.length, 6);

    // 撤回 u2：校验通过后只调用 navigateTree(a1)（u2 的 parent），文件无删除
    const ret = await wrapper.send({ type: "retract_message", entryId: u2 });
    assert.equal(ret.ok, true);
    assert.deepEqual(navCalls, [{ targetId: a1, opts: { summarize: false } }]);
    assert.equal(sm.getLeafId(), a1);
    assert.equal(entriesCount(), baseline);
    assert.deepEqual(messageIds(), baselineMessages);

    // 撤回栈只记 UI 展示/恢复目标；数据本身仍在文件
    const listed = await wrapper.send({ type: "list_retracted" });
    assert.equal(listed.retracted.length, 1);
    assert.equal(listed.retracted[0].entryId, u2);

    // 恢复 u2：只调用 navigateTree(chainTail(u2)) = a2，无 Dock/其它命令
    const res = await wrapper.send({ type: "restore_message", entryId: u2 });
    assert.equal(res.ok, true);
    assert.deepEqual(navCalls[1], { targetId: a2, opts: { summarize: false } });
    assert.equal(sm.getLeafId(), a2);
    assert.equal(entriesCount(), baseline);
    assert.deepEqual(messageIds(), baselineMessages);

    // 恢复后撤回栈清空；全程只有 navigateTree（树导航），无删除/重写命令
    const after = await wrapper.send({ type: "list_retracted" });
    assert.deepEqual(after.retracted, []);
    assert.deepEqual(navCalls.map((c) => c.targetId), [a1, a2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("恢复/切换旁支契约：restore= navigateTree(chainTail)、select_leaf_exact= branch()", async () => {
  const rpc = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const svc = await readFile(new URL("./session-service.ts", import.meta.url), "utf8");

  // 撤回/恢复均实现为树导航（移动 leaf），不产生物理删除
  assert.match(rpc, /case "retract_message"/);
  assert.match(rpc, /this\.inner\.navigateTree\(entry\.parentId/);
  assert.match(rpc, /case "restore_message"/);
  assert.match(rpc, /this\.inner\.navigateTree\(record\.chainTailEntryId/);

  // 恢复旁支也可走 select_leaf_exact：逻辑下沉 SessionService，文件层仅 branch()
  assert.match(rpc, /case "select_leaf_exact"/);
  assert.match(rpc, /sessionService\.selectLeafExact\(/);
  assert.match(svc, /sessionManager\.branch\(trimmedId\)/);

  // retract_message 用例体内不得出现物理删除/重写原语
  const retractCase = rpc.slice(
    rpc.indexOf('case "retract_message"'),
    rpc.indexOf('case "restore_message"'),
  );
  assert.doesNotMatch(retractCase, /writeFileSync|rmSync|unlinkSync|\.delete\(|\.splice\(/);
});
