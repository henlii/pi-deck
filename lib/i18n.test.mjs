import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("规范化 locale 并安全解析持久化值", async () => {
  const { normalizeLocale, parsePersistedLocale } = await jiti.import("./i18n.tsx");
  assert.equal(normalizeLocale("zh-Hans"), "zh-CN");
  assert.equal(normalizeLocale("fr"), "en");
  assert.equal(parsePersistedLocale("not json"), null);
  assert.equal(parsePersistedLocale(JSON.stringify("zh")), "zh-CN");
  assert.equal(parsePersistedLocale(JSON.stringify({ locale: "en" })), "en");
  assert.equal(parsePersistedLocale(JSON.stringify("fr")), null);
  assert.equal(parsePersistedLocale(JSON.stringify({ locale: "fr" })), null);
  assert.equal(parsePersistedLocale(JSON.stringify({ locale: "" })), null);
  assert.equal(normalizeLocale("fr-FR"), "en");
});

test("插值、英文回退和 Intl 映射", async () => {
  const { createTranslator, getIntlLocale } = await jiti.import("./i18n.tsx");
  assert.equal(createTranslator("en")("chatInputPlaceholder"), "Message Pi...");
  assert.equal(createTranslator("zh-CN")("close"), "关闭");
  assert.equal(createTranslator("en")("localeName", { unused: "x" }), "English");
  assert.equal(getIntlLocale("zh-CN"), "zh-CN");
  assert.equal(getIntlLocale("en"), "en-US");
});

function makeMemoryStorage(initial = {}) {
  /** @type {Map<string, string>} */
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

test("locale 迁移：新键优先且不读/不删旧键", async () => {
  const { readPersistedLocale, I18N_STORAGE_KEY, LEGACY_I18N_STORAGE_KEY } = await jiti.import("./i18n.tsx");
  const storage = makeMemoryStorage({
    [I18N_STORAGE_KEY]: JSON.stringify("en"),
    [LEGACY_I18N_STORAGE_KEY]: JSON.stringify("zh-CN"),
  });
  assert.equal(readPersistedLocale(storage), "en");
  assert.equal(storage.map.has(LEGACY_I18N_STORAGE_KEY), true);
  assert.equal(storage.map.get(LEGACY_I18N_STORAGE_KEY), JSON.stringify("zh-CN"));
});

test("locale 迁移：成功迁移后删除旧键", async () => {
  const { readPersistedLocale, I18N_STORAGE_KEY, LEGACY_I18N_STORAGE_KEY } = await jiti.import("./i18n.tsx");
  const storage = makeMemoryStorage({
    [LEGACY_I18N_STORAGE_KEY]: JSON.stringify("zh-CN"),
  });
  assert.equal(readPersistedLocale(storage), "zh-CN");
  assert.equal(storage.map.has(LEGACY_I18N_STORAGE_KEY), false);
  assert.equal(storage.map.get(I18N_STORAGE_KEY), JSON.stringify("zh-CN"));
});

test("locale 迁移：写新键失败不删旧键", async () => {
  const { readPersistedLocale, I18N_STORAGE_KEY, LEGACY_I18N_STORAGE_KEY } = await jiti.import("./i18n.tsx");
  const map = new Map([[LEGACY_I18N_STORAGE_KEY, JSON.stringify("zh-CN")]]);
  const storage = {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem() {
      throw new Error("quota");
    },
    removeItem(key) {
      map.delete(key);
    },
  };
  assert.equal(readPersistedLocale(storage), "zh-CN");
  assert.equal(map.has(LEGACY_I18N_STORAGE_KEY), true);
  assert.equal(map.has(I18N_STORAGE_KEY), false);
});
