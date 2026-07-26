import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("页面清单：appearance/models 无 cwd 可用，skills/plugins 保留导航项并给出提示", async () => {
  const { getSettingsPages } = await jiti.import("./settings-nav.ts");
  const withoutCwd = getSettingsPages(false);
  assert.deepEqual(withoutCwd.map((p) => p.id), ["appearance", "models", "skills", "plugins"]);
  assert.equal(withoutCwd.find((p) => p.id === "appearance").available, true);
  assert.equal(withoutCwd.find((p) => p.id === "models").available, true);
  const skills = withoutCwd.find((p) => p.id === "skills");
  const plugins = withoutCwd.find((p) => p.id === "plugins");
  // 不静默隐藏：导航项仍在，只是不可用且带具体提示。
  assert.equal(skills.available, false);
  assert.equal(skills.unavailableHint, "skills");
  assert.equal(plugins.available, false);
  assert.equal(plugins.unavailableHint, "plugins");
   assert.deepEqual(withoutCwd.map((p) => p.label), ["appearance", "models", "skills", "plugins"]);

  const withCwd = getSettingsPages(true);
  assert.ok(withCwd.every((p) => p.available));
  assert.ok(withCwd.every((p) => p.unavailableHint === undefined));
});

test("最近页解析：合法值还原，损坏/未知/旧格式全部安全回退", async () => {
  const { parseStoredSettingsPage, DEFAULT_SETTINGS_PAGE } = await jiti.import("./settings-nav.ts");
  assert.equal(parseStoredSettingsPage('"models"'), "models");
  assert.equal(parseStoredSettingsPage("skills"), "skills");
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
  const skills = nextMobileSettingsView(models, { type: "select", page: "skills" });
  assert.deepEqual(skills, { page: "skills" });
  // 重复选择同一页返回原对象（不触发多余渲染）。
  assert.equal(nextMobileSettingsView(skills, { type: "select", page: "skills" }), skills);
  // Back 回到导航首页。
  assert.deepEqual(nextMobileSettingsView(skills, { type: "back" }), { page: null });
  assert.deepEqual(nextMobileSettingsView(home, { type: "back" }), { page: null });
});
