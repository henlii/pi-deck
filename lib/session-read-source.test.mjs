import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  resolveSessionManagerForRead,
  buildSessionNavigationSnapshot,
} = await jiti.import("./session-reader.ts");

function entry(id, type, parentId, extra = {}) {
  return { id, type, parentId, timestamp: "2026-01-01T00:00:00.000Z", ...extra };
}

function messageNode(id, children = [], label) {
  return {
    entry: entry(id, "message", null),
    children,
    ...(label !== undefined ? { label } : {}),
  };
}

function makeManager({ leafId, entries, tree, header }) {
  return {
    getEntries: () => entries,
    getLeafId: () => leafId,
    getTree: () => tree,
    getHeader: () => header ?? {
      type: "session",
      version: 3,
      id: "s1",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp",
    },
    getSessionName: () => "test",
  };
}

test("resolveSessionManagerForRead：live alive 时用 live sessionManager", () => {
  const disk = makeManager({ leafId: "A", entries: [], tree: [] });
  const liveMgr = makeManager({ leafId: "B", entries: [], tree: [] });
  let opened = false;
  const sm = resolveSessionManagerForRead({
    filePath: "/tmp/s.jsonl",
    liveSession: {
      isAlive: () => true,
      inner: { sessionManager: liveMgr },
    },
    openFromDisk: () => {
      opened = true;
      return disk;
    },
  });
  assert.equal(sm, liveMgr);
  assert.equal(opened, false);
  assert.equal(sm.getLeafId(), "B");
});

test("resolveSessionManagerForRead：无 live 或 dead 时 open 磁盘", () => {
  const disk = makeManager({ leafId: "A", entries: [], tree: [] });
  const liveMgr = makeManager({ leafId: "B", entries: [], tree: [] });

  const fromDisk = resolveSessionManagerForRead({
    filePath: "/tmp/s.jsonl",
    liveSession: null,
    openFromDisk: () => disk,
  });
  assert.equal(fromDisk.getLeafId(), "A");

  const dead = resolveSessionManagerForRead({
    filePath: "/tmp/s.jsonl",
    liveSession: {
      isAlive: () => false,
      inner: { sessionManager: liveMgr },
    },
    openFromDisk: () => disk,
  });
  assert.equal(dead.getLeafId(), "A");
});

test("buildSessionNavigationSnapshot：磁盘 leaf=A、live branch(B) 时选 B 与对应 context", () => {
  // 路径: u1 → a1(A) 与 u1 → b1(B) 分叉；磁盘 leaf 在 A，live 已 branch 到 B
  const entries = [
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "root" },
    },
    {
      type: "message",
      id: "A",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", provider: "t", model: "m", content: [{ type: "text", text: "branch A" }] },
    },
    {
      type: "message",
      id: "B",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "assistant", provider: "t", model: "m", content: [{ type: "text", text: "branch B" }] },
    },
  ];

  const nodeB = messageNode("B");
  const nodeA = messageNode("A");
  const root = {
    entry: entry("u1", "message", null),
    children: [nodeA, nodeB],
  };

  const diskSm = makeManager({ leafId: "A", entries, tree: [root] });
  const liveSm = makeManager({ leafId: "B", entries, tree: [root] });

  const live = resolveSessionManagerForRead({
    filePath: "/x.jsonl",
    liveSession: { isAlive: () => true, inner: { sessionManager: liveSm } },
    openFromDisk: () => diskSm,
  });
  const liveSnap = buildSessionNavigationSnapshot(live);
  assert.equal(liveSnap.leafId, "B");
  assert.ok(liveSnap.context.entryIds.includes("B"));
  assert.equal(liveSnap.context.entryIds.includes("A"), false);
  assert.ok(
    liveSnap.context.messages.some((m) => m.role === "assistant" && m.content?.[0]?.text === "branch B"),
  );

  const disk = resolveSessionManagerForRead({
    filePath: "/x.jsonl",
    liveSession: null,
    openFromDisk: () => diskSm,
  });
  const diskSnap = buildSessionNavigationSnapshot(disk);
  assert.equal(diskSnap.leafId, "A");
  assert.ok(diskSnap.context.entryIds.includes("A"));
  assert.equal(diskSnap.context.entryIds.includes("B"), false);
});

test("buildSessionNavigationSnapshot：label metadata 派生仍生效", () => {
  const entries = [
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "hi" },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", provider: "t", model: "m", content: [{ type: "text", text: "yo" }] },
    },
    {
      type: "label",
      id: "lbl1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:02.000Z",
      targetId: "a1",
      label: "书签",
    },
  ];
  const lblNode = {
    entry: entry("lbl1", "label", "a1", { targetId: "a1", label: "书签" }),
    children: [],
  };
  const a1Node = {
    entry: entry("a1", "message", "u1"),
    children: [lblNode],
    label: "书签",
  };
  const root = {
    entry: entry("u1", "message", null),
    children: [a1Node],
  };
  const sm = makeManager({ leafId: "lbl1", entries, tree: [root] });
  const snap = buildSessionNavigationSnapshot(sm);
  assert.equal(snap.leafId, "a1");
  assert.equal(
    JSON.stringify(snap.tree).includes('"type":"label"'),
    false,
  );
  // 目标节点仍带解析后的 label
  const find = (nodes, id) => {
    for (const n of nodes) {
      if (n.entry.id === id) return n;
      const f = find(n.children, id);
      if (f) return f;
    }
    return null;
  };
  assert.equal(find(snap.tree, "a1")?.label, "书签");
});
