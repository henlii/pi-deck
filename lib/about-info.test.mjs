import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("buildAboutInfo 从 package.json 形状提取版本与仓库 URL", async () => {
  const { buildAboutInfo } = await jiti.import("./about-info.ts");
  const info = buildAboutInfo({
    name: "@henlii/pi-deck",
    version: "0.1.0",
    homepage: "https://github.com/henlii/pi-deck#readme",
    repository: { type: "git", url: "git+https://github.com/henlii/pi-deck.git" },
    dependencies: {
      "@earendil-works/pi-coding-agent": "0.81.1",
    },
  });
  assert.equal(info.name, "Pi Deck");
  assert.equal(info.version, "0.1.0");
  assert.equal(info.piSdkVersion, "0.81.1");
  assert.equal(info.homepage, "https://github.com/henlii/pi-deck#readme");
  assert.equal(info.repository, "https://github.com/henlii/pi-deck");
});

test("normalizeRepositoryUrl 处理 git+https 与 .git 后缀", async () => {
  const { normalizeRepositoryUrl } = await jiti.import("./about-info.ts");
  assert.equal(
    normalizeRepositoryUrl("git+https://github.com/henlii/pi-deck.git"),
    "https://github.com/henlii/pi-deck",
  );
  assert.equal(
    normalizeRepositoryUrl({ url: "https://github.com/henlii/pi-deck.git" }),
    "https://github.com/henlii/pi-deck",
  );
  assert.equal(normalizeRepositoryUrl(null), null);
  assert.equal(normalizeRepositoryUrl(""), null);
});

test("buildAboutInfo 缺失字段时安全降级", async () => {
  const { buildAboutInfo } = await jiti.import("./about-info.ts");
  const info = buildAboutInfo({});
  assert.equal(info.name, "Pi Deck");
  assert.equal(info.version, "0.0.0");
  assert.equal(info.piSdkVersion, null);
  assert.equal(info.homepage, null);
  assert.equal(info.repository, null);
});
