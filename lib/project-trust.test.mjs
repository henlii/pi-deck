/**
 * 服务端信任边界的集成测试：用临时 agentDir 与临时项目目录驱动真实的
 * SDK `ProjectTrustStore` / `hasTrustRequiringProjectResources`，
 * 不触碰本机 ~/.pi/agent。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// project-trust.ts 走仓库惯例的无扩展名相对 import，node 原生 ESM 解析不了，
// 与 session-file-references 测试一致改用 jiti 加载。
const jiti = createJiti(import.meta.url);
const {
  applyProjectTrustChoice,
  canonicalizeProjectPath,
  getProjectTrustParent,
  getProjectTrustStatus,
  isAllowedProjectCwd,
  isUsableProjectPath,
  listProjectTrustDecisions,
  resolveProjectTrustedForSession,
} = await jiti.import("./project-trust.ts");

/** 建一对 { agentDir, project }，project 下按需放入受信任门禁的 .pi 资源。 */
function makeFixture({ gated = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-deck-trust-"));
  const agentDir = join(root, "agent");
  const project = join(root, "proj");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  if (gated) {
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "settings.json"), "{}\n", "utf-8");
  }
  return { root, agentDir, project, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("未记录且 defaultProjectTrust=ask 时不信任并请求决定", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const status = getProjectTrustStatus(fx.project, fx.agentDir);
  assert.equal(status.requiresTrust, true);
  assert.equal(status.trusted, false);
  assert.equal(status.needsDecision, true);
  assert.equal(status.source, "undecided");
  assert.equal(resolveProjectTrustedForSession(fx.project, fx.agentDir), false);
});

test("没有受门禁资源的目录直接信任，且不写任何文件", (t) => {
  const fx = makeFixture({ gated: false });
  t.after(fx.cleanup);
  const status = getProjectTrustStatus(fx.project, fx.agentDir);
  assert.equal(status.requiresTrust, false);
  assert.equal(status.trusted, true);
  assert.equal(status.needsDecision, false);
  assert.equal(listProjectTrustDecisions(fx.agentDir).decisions.length, 0);
});

test("trust 决策落盘后被后续解析读到，并出现在只读列表", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const after = applyProjectTrustChoice(fx.project, "trust", fx.agentDir);
  assert.equal(after.trusted, true);
  assert.equal(after.source, "stored");
  assert.equal(after.needsDecision, false);

  assert.equal(resolveProjectTrustedForSession(fx.project, fx.agentDir), true);

  const list = listProjectTrustDecisions(fx.agentDir);
  assert.equal(list.error, undefined);
  assert.deepEqual(list.decisions, [
    { path: canonicalizeProjectPath(fx.project), decision: true },
  ]);
  assert.equal(list.defaultProjectTrust, "ask");
});

test("distrust 决策持久化为 false 而不是删除记录", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const after = applyProjectTrustChoice(fx.project, "distrust", fx.agentDir);
  assert.equal(after.trusted, false);
  assert.equal(after.needsDecision, false, "明确拒绝后不再反复提问");
  assert.equal(after.source, "stored");
  const raw = JSON.parse(readFileSync(join(fx.agentDir, "trust.json"), "utf-8"));
  assert.equal(raw[canonicalizeProjectPath(fx.project)], false);
});

test("信任父目录后子目录继承，并清除子目录自身的旧记录", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  applyProjectTrustChoice(fx.project, "distrust", fx.agentDir);
  const after = applyProjectTrustChoice(fx.project, "trust-parent", fx.agentDir);

  assert.equal(after.trusted, true);
  assert.equal(after.inherited, true);
  assert.equal(after.source, "stored-inherited");
  assert.equal(after.storedPath, canonicalizeProjectPath(getProjectTrustParent(fx.project)));

  const raw = JSON.parse(readFileSync(join(fx.agentDir, "trust.json"), "utf-8"));
  assert.equal(
    Object.hasOwn(raw, canonicalizeProjectPath(fx.project)),
    false,
    "子目录旧记录必须被清除，否则会遮蔽父目录决策",
  );
});

test("defaultProjectTrust=always/never 在无记录时生效", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);

  writeFileSync(join(fx.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }), "utf-8");
  const always = getProjectTrustStatus(fx.project, fx.agentDir);
  assert.equal(always.trusted, true);
  assert.equal(always.source, "default-always");
  assert.equal(always.needsDecision, false);

  writeFileSync(join(fx.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }), "utf-8");
  const never = getProjectTrustStatus(fx.project, fx.agentDir);
  assert.equal(never.trusted, false);
  assert.equal(never.source, "default-never");
  assert.equal(never.needsDecision, false);
});

test("trust.json 损坏时列表降级为空并带错误说明，解析不抛错且保守不信任", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeFileSync(join(fx.agentDir, "trust.json"), "{ not json", "utf-8");

  const list = listProjectTrustDecisions(fx.agentDir);
  assert.equal(list.decisions.length, 0);
  assert.ok(list.error, "损坏必须可见，不能静默当作空");

  const status = getProjectTrustStatus(fx.project, fx.agentDir);
  assert.equal(status.trusted, false);
  assert.equal(status.needsDecision, true);
});

test("trust.json 中的 null 值不进入展示列表", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const p = canonicalizeProjectPath(fx.project);
  writeFileSync(join(fx.agentDir, "trust.json"), JSON.stringify({ [p]: null, "/other": true }), "utf-8");
  assert.deepEqual(listProjectTrustDecisions(fx.agentDir).decisions, [{ path: "/other", decision: true }]);
});

test("trust.json 中的字符串/数字非法值整文件降级为空并带错误说明", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const p = canonicalizeProjectPath(fx.project);

  for (const bad of ["yes", 1, 0, { nested: true }, ["x"]]) {
    writeFileSync(join(fx.agentDir, "trust.json"), JSON.stringify({ [p]: bad, "/ok": true }), "utf-8");
    const list = listProjectTrustDecisions(fx.agentDir);
    assert.equal(list.decisions.length, 0, `非法值 ${JSON.stringify(bad)} 不得静默展示为健康`);
    assert.ok(list.error, `非法值 ${JSON.stringify(bad)} 必须带 error 说明`);
    assert.match(list.error, /true|false|null/);
  }
});

test("isUsableProjectPath 只接受存在的目录", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const file = join(fx.project, "file.txt");
  writeFileSync(file, "x", "utf-8");
  assert.equal(isUsableProjectPath(fx.project), true);
  assert.equal(isUsableProjectPath(file), false);
  assert.equal(isUsableProjectPath(join(fx.root, "missing")), false);
  assert.equal(isUsableProjectPath(""), false);
});

test("isAllowedProjectCwd：允许根内通过，前缀相似旁路与域外目录拒绝", async (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  // 旁路：仅共享前缀但不是子路径（/proj 不得放行 /proj-evil）
  const prefixSibling = `${fx.project}-evil`;
  mkdirSync(prefixSibling, { recursive: true });
  t.after(() => rmSync(prefixSibling, { recursive: true, force: true }));

  const outside = mkdtempSync(join(tmpdir(), "pi-deck-trust-out-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));

  const prevCache = globalThis.__piAllowedRootsCache;
  const prevAdditional = globalThis.__piAdditionalAllowedRoots;
  t.after(() => {
    globalThis.__piAllowedRootsCache = prevCache;
    globalThis.__piAdditionalAllowedRoots = prevAdditional;
  });

  const allowed = canonicalizeProjectPath(fx.project);
  globalThis.__piAllowedRootsCache = {
    roots: new Set([allowed]),
    expiresAt: Date.now() + 60_000,
  };
  globalThis.__piAdditionalAllowedRoots = new Set([allowed]);

  assert.equal(await isAllowedProjectCwd(fx.project), true);
  assert.equal(await isAllowedProjectCwd(prefixSibling), false, "前缀相似不得放行");
  assert.equal(await isAllowedProjectCwd(outside), false, "域外目录拒绝");
});
