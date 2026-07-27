import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectTrustUpdates,
  decideProjectTrust,
  getProjectTrustBadgeTone,
  isDefaultProjectTrust,
  isProjectTrustChoice,
  normalizeTrustPath,
} from "./project-trust-model.ts";

const decide = (overrides = {}) =>
  decideProjectTrust({
    cwd: "/home/u/proj",
    requiresTrust: true,
    entry: null,
    defaultProjectTrust: "ask",
    ...overrides,
  });

test("无受门禁资源时直接信任，且不受 defaultProjectTrust 影响", () => {
  for (const defaultProjectTrust of ["ask", "never", "always"]) {
    const status = decide({ requiresTrust: false, defaultProjectTrust });
    assert.equal(status.trusted, true);
    assert.equal(status.needsDecision, false);
    assert.equal(status.source, "no-trust-requiring-resources");
  }
});

test("无受门禁资源时保留已读到的记录用于展示，但不改变结果", () => {
  const status = decide({
    requiresTrust: false,
    entry: { path: "/home/u/proj", decision: false },
  });
  assert.equal(status.trusted, true, "Pi 在这一步直接返回 true，不查 trust.json");
  assert.equal(status.storedDecision, false);
  assert.equal(status.source, "no-trust-requiring-resources");
});

test("trust.json 精确命中优先于 defaultProjectTrust", () => {
  const trusted = decide({
    entry: { path: "/home/u/proj", decision: true },
    defaultProjectTrust: "never",
  });
  assert.equal(trusted.trusted, true);
  assert.equal(trusted.source, "stored");
  assert.equal(trusted.inherited, false);
  assert.equal(trusted.needsDecision, false);

  const distrusted = decide({
    entry: { path: "/home/u/proj", decision: false },
    defaultProjectTrust: "always",
  });
  assert.equal(distrusted.trusted, false);
  assert.equal(distrusted.source, "stored");
  assert.equal(distrusted.needsDecision, false, "已有明确记录就不该再问");
});

test("祖先目录的决策向下继承并标记来源", () => {
  const status = decide({ entry: { path: "/home/u", decision: true } });
  assert.equal(status.trusted, true);
  assert.equal(status.inherited, true);
  assert.equal(status.storedPath, "/home/u");
  assert.equal(status.source, "stored-inherited");
});

test("路径结尾分隔符与反斜杠不会被误判为继承", () => {
  const status = decide({ entry: { path: "/home/u/proj/", decision: true } });
  assert.equal(status.inherited, false);
  assert.equal(status.source, "stored");

  const win = decideProjectTrust({
    cwd: "C:/repo/app",
    requiresTrust: true,
    entry: { path: "C:\\repo\\app", decision: true },
    defaultProjectTrust: "ask",
  });
  assert.equal(win.inherited, false);
});

test("无记录时按 defaultProjectTrust 回退：always 信任、never 不信任且都不提问", () => {
  const always = decide({ defaultProjectTrust: "always" });
  assert.equal(always.trusted, true);
  assert.equal(always.needsDecision, false);
  assert.equal(always.source, "default-always");

  const never = decide({ defaultProjectTrust: "never" });
  assert.equal(never.trusted, false);
  assert.equal(never.needsDecision, false, "Pi 在 never 下不提问");
  assert.equal(never.source, "default-never");
});

test("ask 且无记录：本次降级为不信任并请求决定", () => {
  const status = decide();
  assert.equal(status.trusted, false, "等价于 Pi 无 UI 时的保守结果");
  assert.equal(status.needsDecision, true);
  assert.equal(status.source, "undecided");
  assert.equal(status.storedDecision, null);
  assert.equal(status.storedPath, null);
});

test("写入语义与 SDK getProjectTrustOptions 一致", () => {
  assert.deepEqual(buildProjectTrustUpdates("/p/app", "/p", "trust"), [
    { path: "/p/app", decision: true },
  ]);
  assert.deepEqual(buildProjectTrustUpdates("/p/app", "/p", "distrust"), [
    { path: "/p/app", decision: false },
  ]);
  assert.deepEqual(
    buildProjectTrustUpdates("/p/app", "/p", "trust-parent"),
    [
      { path: "/p", decision: true },
      { path: "/p/app", decision: null },
    ],
    "信任父目录必须同时清除子目录旧记录，否则更具体的记录会遮蔽父目录",
  );
});

test("根目录下请求信任父目录时拒绝而不是写坏 trust.json", () => {
  assert.throws(() => buildProjectTrustUpdates("/", null, "trust-parent"), /父目录/);
});

test("徽章色调：无门禁不显示，未决优先于不信任", () => {
  assert.equal(getProjectTrustBadgeTone(decide({ requiresTrust: false })), "none");
  assert.equal(getProjectTrustBadgeTone(decide()), "undecided");
  assert.equal(getProjectTrustBadgeTone(decide({ defaultProjectTrust: "never" })), "untrusted");
  assert.equal(
    getProjectTrustBadgeTone(decide({ entry: { path: "/home/u/proj", decision: false } })),
    "untrusted",
  );
  assert.equal(
    getProjectTrustBadgeTone(decide({ entry: { path: "/home/u/proj", decision: true } })),
    "trusted",
  );
});

test("输入守卫拒绝未知值", () => {
  assert.equal(isDefaultProjectTrust("ask"), true);
  assert.equal(isDefaultProjectTrust("Ask"), false);
  assert.equal(isDefaultProjectTrust(null), false);
  assert.equal(isProjectTrustChoice("trust-parent"), true);
  assert.equal(isProjectTrustChoice("session-only"), false);
  assert.equal(isProjectTrustChoice(undefined), false);
});

test("normalizeTrustPath 保留根路径", () => {
  assert.equal(normalizeTrustPath("/"), "/");
  assert.equal(normalizeTrustPath("/a/b/"), "/a/b");
  assert.equal(normalizeTrustPath("C:\\a\\b\\"), "C:/a/b");
});
