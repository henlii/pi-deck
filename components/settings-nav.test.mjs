import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("页面清单：appearance/models/memory/agents/trust 无 cwd 可用，skills/plugins 保留导航项并给出提示", async () => {
  const { getSettingsPages } = await jiti.import("./settings-nav.ts");
  const withoutCwd = getSettingsPages(false);
  assert.deepEqual(withoutCwd.map((p) => p.id), ["appearance", "models", "memory", "agents", "defaults", "skills", "plugins", "trust"]);
  assert.equal(withoutCwd.find((p) => p.id === "appearance").available, true);
  assert.equal(withoutCwd.find((p) => p.id === "models").available, true);
  // memory 可看全局 Hermes 记忆，不依赖活动项目。
  assert.equal(withoutCwd.find((p) => p.id === "memory").available, true);
  // agents 可看 builtin/user 花名册与 run-history，不依赖活动项目。
  assert.equal(withoutCwd.find((p) => p.id === "agents").available, true);
  // defaults 读写全局 settings.json 白名单键，不依赖活动项目。
  assert.equal(withoutCwd.find((p) => p.id === "defaults").available, true);
  // trust 是全局 trust.json 的只读视图，不依赖活动项目。
  assert.equal(withoutCwd.find((p) => p.id === "trust").available, true);
  const skills = withoutCwd.find((p) => p.id === "skills");
  const plugins = withoutCwd.find((p) => p.id === "plugins");
  // 不静默隐藏：导航项仍在，只是不可用且带具体提示。
  assert.equal(skills.available, false);
  assert.equal(skills.unavailableHint, "skills");
  assert.equal(plugins.available, false);
  assert.equal(plugins.unavailableHint, "plugins");
  assert.deepEqual(withoutCwd.map((p) => p.label), ["appearance", "models", "memory", "agents", "defaults", "skills", "plugins", "trust"]);

  const withCwd = getSettingsPages(true);
  assert.ok(withCwd.every((p) => p.available));
  assert.ok(withCwd.every((p) => p.unavailableHint === undefined));
});

test("最近页解析：合法值还原，损坏/未知/旧格式全部安全回退", async () => {
  const { parseStoredSettingsPage, DEFAULT_SETTINGS_PAGE } = await jiti.import("./settings-nav.ts");
  assert.equal(parseStoredSettingsPage('"models"'), "models");
  assert.equal(parseStoredSettingsPage("skills"), "skills");
  assert.equal(parseStoredSettingsPage('"memory"'), "memory");
  // 旧格式对象。
  assert.equal(parseStoredSettingsPage('{"page":"plugins"}'), "plugins");
  // 各类损坏输入。
  for (const bad of [null, undefined, "", "not-json", '"unknown-page"', "{}", "[]", "123", '{"page":42}']) {
    assert.equal(parseStoredSettingsPage(bad), DEFAULT_SETTINGS_PAGE, `输入: ${String(bad)}`);
  }
  assert.equal(DEFAULT_SETTINGS_PAGE, "appearance");
});

test("移动端导航状态转换：首页 → 页面 → Back 回首页，重复选择幂等", async () => {
  const { nextMobileSettingsView } = await jiti.import("./settings-nav.ts");
  const home = { page: null };
  const models = nextMobileSettingsView(home, { type: "select", page: "models" });
  assert.deepEqual(models, { page: "models" });
  // 页面间直接切换。
  const memory = nextMobileSettingsView(models, { type: "select", page: "memory" });
  assert.deepEqual(memory, { page: "memory" });
  // 重复选择同一页返回原对象（不触发多余渲染）。
  assert.equal(nextMobileSettingsView(memory, { type: "select", page: "memory" }), memory);
  // Back 回到导航首页。
  assert.deepEqual(nextMobileSettingsView(memory, { type: "back" }), { page: null });
  assert.deepEqual(nextMobileSettingsView(home, { type: "back" }), { page: null });
});
