import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  projectWorkspaceHistory,
  resolveWorkspaceHistoryStoragePaths,
  isShadowGitDirWithinStorage,
  isSafeCommitRef,
  listWorkspaceSnapshotDiff,
  isWorkspaceSnapshotData,
  WH_MAX_MARKERS,
} = await jiti.import("./workspace-history.ts");

function msg(id, parentId) {
  return {
    id,
    parentId,
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: id },
  };
}

function snap(id, parentId, data) {
  return {
    id,
    parentId,
    type: "custom",
    customType: "workspace-history.snapshot",
    timestamp: data.createdAt ?? "2026-01-01T00:00:00.000Z",
    data,
  };
}

function validData(overrides = {}) {
  return {
    v: 1,
    kind: "before",
    commit: "abcdef0123456789abcdef0123456789abcdef01",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("baseline/before/after/manual 投影与计数", () => {
  const entries = [
    msg("u1", null),
    snap("s1", "u1", validData({ kind: "baseline", commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })),
    snap("s2", "s1", validData({
      kind: "before",
      commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      promptText: "do work",
      userEntryId: "u1",
    })),
    snap("s3", "s2", validData({
      kind: "after",
      commit: "cccccccccccccccccccccccccccccccccccccccc",
      beforeSnapshotId: "s2",
    })),
    snap("s4", "s3", validData({
      kind: "manual",
      commit: "dddddddddddddddddddddddddddddddddddddddd",
      label: "safe point",
    })),
  ];

  const view = projectWorkspaceHistory(entries, "s4");
  assert.ok(view);
  assert.equal(view.hasData, true);
  assert.equal(view.counts.total, 4);
  assert.equal(view.counts.byKind.baseline, 1);
  assert.equal(view.counts.byKind.before, 1);
  assert.equal(view.counts.byKind.after, 1);
  assert.equal(view.counts.byKind.manual, 1);
  assert.deepEqual(view.markers.map((m) => m.kind), ["baseline", "before", "after", "manual"]);
  assert.equal(view.markers[0].shortCommit, "aaaaaaa");
  assert.equal(view.markers[1].promptText, "do work");
  assert.equal(view.markers[2].beforeSnapshotId, "s2");
  assert.equal(view.markers[3].label, "safe point");
});

test("兄弟分支隔离", () => {
  const entries = [
    msg("u1", null),
    msg("a1", "u1"),
    snap("snapA", "a1", validData({
      kind: "after",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      label: "branch-A",
    })),
    msg("b1", "u1"),
    snap("snapB", "b1", validData({
      kind: "after",
      commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      label: "branch-B",
    })),
  ];

  const viewA = projectWorkspaceHistory(entries, "snapA");
  assert.ok(viewA);
  assert.deepEqual(viewA.markers.map((m) => m.label), ["branch-A"]);

  const viewB = projectWorkspaceHistory(entries, "snapB");
  assert.ok(viewB);
  assert.deepEqual(viewB.markers.map((m) => m.label), ["branch-B"]);

  assert.equal(projectWorkspaceHistory(entries, "a1"), null);
});

test("无效 data 忽略", () => {
  const entries = [
    msg("u1", null),
    snap("bad1", "u1", { v: 2, kind: "before", commit: "abc", createdAt: "t" }),
    snap("bad2", "bad1", { v: 1, kind: "nope", commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", createdAt: "t" }),
    snap("bad3", "bad2", { v: 1, kind: "before", commit: "not-hex!!", createdAt: "t" }),
    {
      id: "unk",
      parentId: "bad3",
      type: "custom",
      customType: "other.snapshot",
      data: validData(),
    },
    snap("ok", "unk", validData({ kind: "manual", commit: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" })),
  ];

  const view = projectWorkspaceHistory(entries, "ok");
  assert.ok(view);
  assert.equal(view.counts.total, 1);
  assert.equal(view.markers[0].kind, "manual");
});

test("无 snapshot → null", () => {
  const entries = [
    msg("u1", null),
    {
      id: "c1",
      parentId: "u1",
      type: "custom",
      customType: "something.else",
      data: { x: 1 },
    },
  ];
  assert.equal(projectWorkspaceHistory(entries, "c1"), null);
  assert.equal(projectWorkspaceHistory([], null), null);
});

test("有界截断：保留较新（slice 末尾）", () => {
  const entries = [msg("u1", null)];
  let parent = "u1";
  for (let i = 0; i < WH_MAX_MARKERS + 5; i++) {
    const id = `s${i}`;
    const commit = i.toString(16).padStart(40, "0");
    entries.push(snap(id, parent, validData({
      kind: i % 2 === 0 ? "before" : "after",
      commit,
      label: `n${i}`,
    })));
    parent = id;
  }

  const leaf = `s${WH_MAX_MARKERS + 4}`;
  const view = projectWorkspaceHistory(entries, leaf);
  assert.ok(view);
  assert.equal(view.counts.total, WH_MAX_MARKERS + 5);
  assert.equal(view.markers.length, WH_MAX_MARKERS);
  assert.equal(view.markers[0].label, `n${5}`);
  assert.equal(view.markers[view.markers.length - 1].label, `n${WH_MAX_MARKERS + 4}`);
});

test("isWorkspaceSnapshotData 校验边界", () => {
  assert.equal(isWorkspaceSnapshotData(validData()), true);
  assert.equal(isWorkspaceSnapshotData(validData({ label: "" })), false);
  assert.equal(isWorkspaceSnapshotData(null), false);
});

test("resolveWorkspaceHistoryStoragePaths 路径形状", () => {
  const home = "/tmp/wh-home-test";
  const cwd = "/tmp/wh-cwd-test";
  const paths = resolveWorkspaceHistoryStoragePaths({
    cwd,
    sessionId: "sess-1",
    homeDir: home,
  });
  const expectedHash = createHash("sha256").update(path.normalize(path.resolve(cwd))).digest("hex").slice(0, 24);
  assert.equal(paths.workspaceHash, expectedHash);
  assert.ok(paths.storageDir.endsWith(path.join(".pi", "agent", "state", "workspace-history")));
  assert.equal(paths.shadowGitDir, path.join(paths.sessionRoot, "repo.git"));
  assert.equal(paths.reusableGitDir, path.join(paths.storageDir, "workspaces", expectedHash, "repo.git"));
  assert.ok(paths.sessionRoot.includes("sessions"));
  assert.ok(paths.sessionRoot.includes("sess-1"));
});

test("diff 安全：非法 commit / 越界 git-dir 拒绝", async () => {
  assert.equal(isSafeCommitRef("abc"), false);
  assert.equal(isSafeCommitRef("abcdef0"), true);
  assert.equal(isSafeCommitRef("../etc/passwd"), false);

  const storage = mkdtempSync(path.join(tmpdir(), "wh-storage-"));
  try {
    const outside = mkdtempSync(path.join(tmpdir(), "wh-outside-"));
    try {
      assert.equal(isShadowGitDirWithinStorage(outside, storage), false);

      const badCommit = await listWorkspaceSnapshotDiff({
        shadowGitDir: path.join(storage, "repo.git"),
        fromCommit: "short",
        toCommit: "abcdef0",
        storageDir: storage,
      });
      assert.deepEqual(badCommit.files, []);
      assert.equal(badCommit.error, "invalid commit ref");

      const escape = await listWorkspaceSnapshotDiff({
        shadowGitDir: path.join(outside, "repo.git"),
        fromCommit: "abcdef0123456789",
        toCommit: "fedcba9876543210",
        storageDir: storage,
      });
      assert.deepEqual(escape.files, []);
      assert.equal(escape.error, "shadow git dir outside storage bound");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});

test("diff：合法边界内但 git 失败时降级 error", async () => {
  const storage = mkdtempSync(path.join(tmpdir(), "wh-storage-"));
  try {
    const shadow = path.join(storage, "workspaces", "x", "sessions", "s", "repo.git");
    mkdirSync(shadow, { recursive: true });
    // 非 bare git 目录 → git diff 失败
    writeFileSync(path.join(shadow, "not-a-git"), "x");
    const result = await listWorkspaceSnapshotDiff({
      shadowGitDir: shadow,
      fromCommit: "abcdef0123456789",
      toCommit: "fedcba9876543210",
      storageDir: storage,
    });
    assert.deepEqual(result.files, []);
    assert.ok(result.error);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});
