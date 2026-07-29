import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import {
  REQUIRED_NEXT_FILES,
  auditReleasePackage,
  auditReleaseTgz,
  buildNpmPackTgzFixture,
  buildPaxFollowedByFileTar,
  buildTarEntriesBuffer,
  findForbiddenPathReason,
  formatAuditReport,
  loadWorkspaceTextContents,
  normalizePackDryRun,
  parsePaxRecords,
  parseTarBuffer,
  parseTarNumericField,
  readNpmPackTgz,
  scanSensitiveContent,
  validatePackageRelativePath,
  verifyTarHeaderChecksum,
} from "./release-package-audit.mjs";

function makeMinimalPackFiles(extra = []) {
  const base = [
    ...REQUIRED_NEXT_FILES.map((path) => ({ path, size: 10 })),
    { path: ".next/server/app/page.js", size: 100 },
    { path: ".next/static/chunks/main.js", size: 200 },
    { path: "bin/pi-deck.js", size: 50 },
    { path: "bin/pi-deck-options.js", size: 30 },
    { path: "package.json", size: 40 },
    { path: "README.md", size: 40 },
    { path: "LICENSE", size: 40 },
  ];
  return [...base, ...extra];
}

function minimalFileContents(overrides = {}) {
  /** @type {Record<string, string>} */
  const contents = {
    "package.json": JSON.stringify({
      name: "@henlii/pi-deck",
      version: "0.1.0",
      bin: { "pi-deck": "bin/pi-deck.js" },
    }),
    "README.md": "ok",
    LICENSE: "MIT",
    "bin/pi-deck.js": "#!/usr/bin/env node\n",
    "bin/pi-deck-options.js": "module.exports={};\n",
    ".next/BUILD_ID": "abc",
    ".next/build-manifest.json": "{}",
    ".next/routes-manifest.json": "{}",
    ".next/prerender-manifest.json": "{}",
    ".next/app-path-routes-manifest.json": "{}",
    ".next/server/pages-manifest.json": "{}",
    ".next/server/app-paths-manifest.json": "{}",
    ".next/server/middleware-manifest.json": "{}",
    ".next/server/functions-config-manifest.json": "{}",
    ".next/server/next-font-manifest.json": "{}",
    ".next/server/server-reference-manifest.json": "{}",
    ".next/server/app/page.js": "export default function Page(){}",
    ".next/static/chunks/main.js": "console.log(1)",
  };
  return { ...contents, ...overrides };
}

function auditFromFiles(files, overrides = {}) {
  const pack = normalizePackDryRun({
    name: "@henlii/pi-deck",
    version: "0.1.0",
    filename: "henlii-pi-deck-0.1.0.tgz",
    size: 1000,
    unpackedSize: 5000,
    files,
  });
  const { fileContents: overrideContents, ...rest } = overrides;
  const fileContents =
    overrideContents !== undefined ? overrideContents : minimalFileContents();
  return auditReleasePackage({
    pack,
    bin: { "pi-deck": "bin/pi-deck.js" },
    repoRoot: "/workspace/pi-deck",
    homeDir: "/home/devuser",
    fileContents,
    ...rest,
  });
}

function makeLegalTgzFiles(extra = [], pkgOverrides = {}) {
  const pkg = {
    name: "@henlii/pi-deck",
    version: "0.1.0",
    bin: { "pi-deck": "bin/pi-deck.js" },
    ...pkgOverrides,
  };
  return [
    { path: "package.json", content: JSON.stringify(pkg) },
    { path: "README.md", content: "Pi Deck" },
    { path: "LICENSE", content: "MIT" },
    { path: "bin/pi-deck.js", content: "#!/usr/bin/env node\nconsole.log('ok');\n" },
    { path: "bin/pi-deck-options.js", content: "module.exports={};\n" },
    ...REQUIRED_NEXT_FILES.map((p) => ({
      path: p,
      content: p.includes("BUILD_ID") ? "bid" : "{}",
    })),
    { path: ".next/server/app/page.js", content: "export default 1" },
    { path: ".next/static/chunks/main.js", content: "console.log(1)" },
    ...extra,
  ];
}

test("通过：最小合法清单", () => {
  const result = auditFromFiles(makeMinimalPackFiles());
  assert.equal(result.ok, true);
  assert.equal(result.violations.length, 0);
  assert.match(formatAuditReport(result), /结果: 通过/);
  assert.equal(result.groups.public, 0);
});

test("失败：public/brand SVG 入包", () => {
  const result = auditFromFiles(
    makeMinimalPackFiles([{ path: "public/brand/logo.svg", size: 100 }]),
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some(
      (v) => v.path === "public/brand/logo.svg" && /禁入路径/.test(v.reason),
    ),
  );
});

test("失败：缺少必要构建产物", () => {
  const files = makeMinimalPackFiles().filter((f) => f.path !== ".next/BUILD_ID");
  const result = auditFromFiles(files);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.path === ".next/BUILD_ID"));
});

test("失败：缺少 .next/server 与 static 文件", () => {
  const files = makeMinimalPackFiles().filter(
    (f) => !f.path.startsWith(".next/server/") && !f.path.startsWith(".next/static/"),
  );
  const stripped = files.filter((f) => !f.path.startsWith(".next/server/"));
  const result = auditFromFiles(stripped);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.path === ".next/server/**"));
  assert.ok(result.violations.some((v) => v.path === ".next/static/**"));
});

test("失败：禁入路径含 files 排除项与 .npmrc/.envrc", () => {
  for (const bad of [
    "app/page.tsx",
    "lib/rpc-manager.ts",
    ".next/images-manifest.json",
    ".next/export-marker.json",
    ".next/react-loadable-manifest.json",
    ".next/server/next-font-manifest.js",
    ".npmrc",
    ".envrc",
    "next.config.ts",
    "next.config.cjs",
    "next.config.mts",
    "next.config.cts",
    "public",
    "public/brand/logo.svg",
  ]) {
    assert.ok(findForbiddenPathReason(bad), bad);
  }
  // .env.example 仍由 .env. 前缀禁入
  assert.ok(findForbiddenPathReason(".env.example"));
  // suffix ASCII 大小写不敏感
  for (const bad of [
    "secrets/KEY.PEM",
    "secrets/id_rsa.KEY",
    ".next/static/chunks/main.JS.MAP",
    ".next/server/page.NFT.JSON",
  ]) {
    assert.ok(findForbiddenPathReason(bad), bad);
  }
  // exact/prefix 仍大小写敏感：App/ 不得误伤
  assert.equal(findForbiddenPathReason("App/page.tsx"), null);
});

test("失败：注册或打包 pi-web bin", () => {
  const withBin = auditFromFiles(makeMinimalPackFiles(), {
    bin: { "pi-deck": "bin/pi-deck.js", "pi-web": "bin/pi-deck.js" },
  });
  assert.equal(withBin.ok, false);
  assert.ok(withBin.violations.some((v) => /pi-web/.test(v.path) || /pi-web/.test(v.reason)));
});

test("失败：敏感内容与开发机路径", () => {
  assert.ok(scanSensitiveContent("-----BEGIN RSA PRIVATE KEY-----\nx").some((r) => /私钥/.test(r)));
  assert.ok(scanSensitiveContent('api_key: "sk-live-abcdefghijklmnop"').some((r) => /credential/i.test(r)));
  assert.equal(scanSensitiveContent("https://deck.namixinxi.cn/app").length, 0);
  const result = auditFromFiles(makeMinimalPackFiles([{ path: ".next/server/leak.js", size: 50 }]), {
    fileContents: {
      ...minimalFileContents(),
      ".next/server/leak.js": 'const REPO="/workspace/pi-deck/secret";\n',
    },
  });
  assert.equal(result.ok, false);
});

test("失败：大于 256KiB 的文本后半段敏感内容", () => {
  const pad = "x".repeat(300 * 1024);
  const body = `${pad}\nconst REPO="/workspace/pi-deck/secret-tail";\n`;
  const result = auditFromFiles(
    makeMinimalPackFiles([{ path: ".next/server/huge.js", size: Buffer.byteLength(body) }]),
    {
      fileContents: {
        ...minimalFileContents(),
        ".next/server/huge.js": body,
      },
    },
  );
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.path === ".next/server/huge.js"));
});

test("失败：单文件与总扫描预算超限 fail closed", () => {
  const single = auditFromFiles(
    makeMinimalPackFiles([{ path: ".next/server/big.js", size: 1000 }]),
    {
      contentScanSingleFileBytes: 100,
      fileContents: { ...minimalFileContents(), ".next/server/big.js": "a".repeat(1000) },
    },
  );
  assert.equal(single.ok, false);
  assert.ok(single.violations.some((v) => /单文件扫描预算超限/.test(v.reason)));

  const total = auditFromFiles(makeMinimalPackFiles(), {
    contentScanTotalBytes: 50,
    fileContents: minimalFileContents(),
  });
  assert.equal(total.ok, false);
  assert.ok(total.violations.some((v) => /总扫描预算超限/.test(v.reason)));
});

test("失败：文本内容缺失不得静默跳过", () => {
  const result = auditFromFiles(makeMinimalPackFiles(), {
    fileContents: {},
    requireTextContents: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => /缺失|无法完整扫描/.test(v.reason)));
});

test("路径校验：控制字符、段首尾空白、穿越", () => {
  assert.equal(validatePackageRelativePath("app\u0001/page.tsx").ok, false);
  assert.equal(validatePackageRelativePath("foo /bar").ok, false);
  assert.equal(validatePackageRelativePath("foo/ bar").ok, false);
  assert.equal(validatePackageRelativePath("../etc/passwd").ok, false);
  assert.equal(validatePackageRelativePath("/etc/passwd").ok, false);
  assert.equal(validatePackageRelativePath("a\0b").ok, false);
  assert.equal(validatePackageRelativePath("bin/my file.js").ok, true);
  assert.equal(validatePackageRelativePath("中文/文件.js").ok, true);
});

test("pre 工作区读取：路径越界与非法 fail closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-audit-"));
  try {
    fs.writeFileSync(path.join(dir, "ok.js"), "console.log(1)\n");
    const outside = loadWorkspaceTextContents(dir, ["../secret.js"]);
    assert.ok(outside["../secret.js"] || outside["secret.js"] || Object.values(outside).length > 0);
    const hit = Object.values(outside)[0];
    assert.ok(hit?.error && /非法|越出|路径/.test(hit.error), JSON.stringify(outside));

    const ctrl = loadWorkspaceTextContents(dir, ["app\u0001/page.tsx"]);
    const ctrlHit = Object.values(ctrl)[0];
    assert.ok(ctrlHit?.error && /控制字符|非法/.test(ctrlHit.error));

    const ok = loadWorkspaceTextContents(dir, ["ok.js"]);
    assert.equal(ok["ok.js"]?.text?.includes("console"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("header checksum 损坏 fail closed 并停止", () => {
  const tar = buildTarEntriesBuffer([
    { path: "package.json", content: "{}", corruptChecksum: true },
    { path: "bin/pi-deck.js", content: "ok" },
  ]);
  const parsed = parseTarBuffer(tar);
  assert.ok(parsed.violations.some((v) => /checksum/.test(v.reason)));
  assert.equal(parsed.entries.length, 0);
});

test("GNU/base-256 size fail closed", () => {
  const field = Buffer.alloc(12, 0);
  field[0] = 0x80;
  field.writeUInt32BE(100, 8);
  const n = parseTarNumericField(field, 0, 12);
  assert.equal(n.ok, false);
  assert.match(n.reason, /base-256/);

  const tar = buildTarEntriesBuffer([
    { path: "package.json", content: "x".repeat(10), base256Size: true, sizeOverride: 10 },
  ]);
  const parsed = parseTarBuffer(tar);
  assert.ok(parsed.violations.some((v) => /base-256|size/.test(v.reason)));
});

test("parseTarNumericField 非八进制垃圾 fail closed", () => {
  const field = Buffer.alloc(12, 0);
  field.write("99xyz\0", 0, "utf8");
  const n = parseTarNumericField(field, 0, 12);
  assert.equal(n.ok, false);
  assert.match(n.reason, /八进制|非法/);
});

test("tar 部分成功后遇解析违规则 auditReleaseTgz.ok=false", () => {
  // 先合法 package.json，再损坏 checksum 的第二条目 → 解析违规 + 端到端失败
  const tar = buildTarEntriesBuffer([
    {
      path: "package.json",
      content: JSON.stringify({
        name: "@henlii/pi-deck",
        version: "0.1.0",
        bin: { "pi-deck": "bin/pi-deck.js" },
      }),
    },
    { path: "bin/pi-deck.js", content: "ok", corruptChecksum: true },
  ]);
  const tgz = zlib.gzipSync(tar);
  const result = auditReleaseTgz({ tgzPathOrBuffer: tgz });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => /checksum/.test(v.reason)));
});

test("通过：真实 tgz 合法 fixture", () => {
  const tgz = buildNpmPackTgzFixture(makeLegalTgzFiles());
  const result = auditReleaseTgz({
    tgzPathOrBuffer: tgz,
    filename: "fixture.tgz",
    repoRoot: "/workspace/pi-deck",
    homeDir: "/home/devuser",
    expectedName: "@henlii/pi-deck",
    expectedVersion: "0.1.0",
  });
  assert.equal(result.ok, true, formatAuditReport(result));
});

test("失败：tgz 内禁入路径", () => {
  const tgz = buildNpmPackTgzFixture(
    makeLegalTgzFiles([{ path: "app/page.tsx", content: "export default 1" }]),
  );
  const result = auditReleaseTgz({ tgzPathOrBuffer: tgz });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.path === "app/page.tsx"));
});

test("失败：tgz 文本后半段敏感内容", () => {
  const pad = "y".repeat(300 * 1024);
  const body = `${pad}\napi_key: "sk-live-abcdefghijklmnop"\n`;
  const tgz = buildNpmPackTgzFixture(
    makeLegalTgzFiles([{ path: ".next/server/tail.js", content: body }]),
  );
  const result = auditReleaseTgz({ tgzPathOrBuffer: tgz, repoRoot: "/workspace/pi-deck" });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.path === ".next/server/tail.js"));
});

test("失败：tgz 路径穿越", () => {
  const tgz = buildNpmPackTgzFixture([
    ...makeLegalTgzFiles(),
    { path: "x", rawName: "package/../../evil.js", content: "evil" },
  ]);
  const result = auditReleaseTgz({ tgzPathOrBuffer: tgz });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => /路径穿越|非法路径/.test(v.reason)));
});

test("失败：tgz 符号链接与硬链接与特殊类型", () => {
  for (const [typeflag, re] of [
    ["2", /符号链接/],
    ["1", /硬链接/],
    ["3", /特殊类型/],
    ["4", /特殊类型/],
    ["6", /特殊类型/],
  ]) {
    const tgz = buildNpmPackTgzFixture([
      ...makeLegalTgzFiles(),
      { path: "bin/x", typeflag, linkname: "pi-deck.js", content: "" },
    ]);
    const result = auditReleaseTgz({ tgzPathOrBuffer: tgz });
    assert.equal(result.ok, false, typeflag);
    assert.ok(
      result.violations.some((v) => re.test(v.reason)),
      `${typeflag}: ${JSON.stringify(result.violations)}`,
    );
  }
});

test("失败：tgz 压缩/解压或条目预算异常", () => {
  const huge = Buffer.alloc(2000, 0x61);
  const tgz = buildNpmPackTgzFixture(makeLegalTgzFiles([{ path: ".next/server/big.bin", content: huge }]));
  const entryOver = auditReleaseTgz({
    tgzPathOrBuffer: tgz,
    tgzLimits: {
      maxEntryBytes: 500,
      maxUnpackedBytes: 64 * 1024 * 1024,
      maxCompressedBytes: 64 * 1024 * 1024,
    },
  });
  assert.equal(entryOver.ok, false);
  assert.ok(entryOver.violations.some((v) => /超限/.test(v.reason)));

  const compressedOver = auditReleaseTgz({
    tgzPathOrBuffer: tgz,
    tgzLimits: { maxCompressedBytes: 10 },
  });
  assert.equal(compressedOver.ok, false);
  assert.ok(compressedOver.violations.some((v) => /压缩体超限/.test(v.reason)));
});

test("失败：tgz package.json 含 pi-web bin", () => {
  const tgz = buildNpmPackTgzFixture(
    makeLegalTgzFiles([], {
      bin: { "pi-deck": "bin/pi-deck.js", "pi-web": "bin/pi-deck.js" },
    }),
  );
  const result = auditReleaseTgz({ tgzPathOrBuffer: tgz });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => /pi-web/.test(v.path) || /pi-web/.test(v.reason)));
});

test("失败：tgz 包名/版本与期望不一致", () => {
  const tgz = buildNpmPackTgzFixture(makeLegalTgzFiles());
  const wrongName = auditReleaseTgz({
    tgzPathOrBuffer: tgz,
    expectedName: "@other/pkg",
    expectedVersion: "0.1.0",
  });
  assert.equal(wrongName.ok, false);
  assert.ok(wrongName.violations.some((v) => /包名与期望不一致/.test(v.reason)));

  const wrongVer = auditReleaseTgz({
    tgzPathOrBuffer: tgz,
    expectedName: "@henlii/pi-deck",
    expectedVersion: "9.9.9",
  });
  assert.equal(wrongVer.ok, false);
  assert.ok(wrongVer.violations.some((v) => /版本与期望不一致/.test(v.reason)));
});

test("GNU L 长名被正确应用", () => {
  const longRel = "package/.next/server/" + "a".repeat(120) + ".js";
  const tar = buildTarEntriesBuffer([
    {
      path: "long",
      rawName: "././@LongLink",
      typeflag: "L",
      content: longRel + "\0",
    },
    {
      path: "short",
      rawName: "package/short.js",
      content: "export default 1",
    },
  ]);
  const parsed = parseTarBuffer(tar);
  assert.equal(parsed.violations.length, 0, JSON.stringify(parsed.violations));
  const rel = longRel.replace(/^package\//, "");
  assert.ok(parsed.entries.some((e) => e.path === rel));
});

test("PAX x path/size 覆盖", () => {
  const tar = buildPaxFollowedByFileTar({
    paxType: "x",
    records: {
      path: "package/.next/server/from-pax.js",
      size: "5",
    },
    follow: {
      path: "ignored.js",
      content: "helloXXXX",
    },
  });
  // size=5 只取前 5 字节
  const parsed = parseTarBuffer(tar);
  assert.equal(parsed.violations.length, 0, JSON.stringify(parsed.violations));
  const hit = parsed.entries.find((e) => e.path === ".next/server/from-pax.js");
  assert.ok(hit);
  assert.equal(hit.size, 5);
  assert.equal(hit.content.toString("utf8"), "hello");
});

test("PAX g 全局与后续 x 合并", () => {
  const gBody = (() => {
    const body = "path=package/from-global.js\n";
    let record = `${body.length} ${body}`;
    for (let i = 0; i < 5; i++) {
      const n = Buffer.byteLength(record, "utf8");
      record = `${n} ${body}`;
      if (Buffer.byteLength(record, "utf8") === n) break;
    }
    return record;
  })();
  const xBody = (() => {
    const body = "size=3\n";
    let record = `${body.length} ${body}`;
    for (let i = 0; i < 5; i++) {
      const n = Buffer.byteLength(record, "utf8");
      record = `${n} ${body}`;
      if (Buffer.byteLength(record, "utf8") === n) break;
    }
    return record;
  })();
  const tar = buildTarEntriesBuffer([
    { path: "g", rawName: "package/PaxHeader", content: gBody, typeflag: "g" },
    { path: "x", rawName: "./PaxHeader", content: xBody, typeflag: "x" },
    { path: "f", rawName: "package/ignored.js", content: "abcdef" },
  ]);
  const parsed = parseTarBuffer(tar);
  assert.equal(parsed.violations.length, 0, JSON.stringify(parsed.violations));
  const hit = parsed.entries.find((e) => e.path === "from-global.js");
  assert.ok(hit);
  assert.equal(hit.size, 3);
  assert.equal(hit.content.toString("utf8"), "abc");
});

test("PAX 记录非法 fail closed", () => {
  const bad = parsePaxRecords("not-a-pax");
  assert.equal(bad.ok, false);
});

test("重复路径 fail closed", () => {
  const tar = buildTarEntriesBuffer([
    { path: "package.json", content: '{"a":1}' },
    { path: "package.json", content: '{"a":2}' },
  ]);
  const parsed = parseTarBuffer(tar);
  assert.ok(parsed.violations.some((v) => /重复路径/.test(v.reason)));
});

test("双零结束后非零 trailing data fail closed", () => {
  const base = buildTarEntriesBuffer([{ path: "package.json", content: "{}" }]);
  // 去掉末尾后追加垃圾
  const tar = Buffer.concat([base, Buffer.from("GARBAGE")]);
  const parsed = parseTarBuffer(tar);
  assert.ok(parsed.violations.some((v) => /trailing|非零/.test(v.reason)));
});

test("未知 typeflag fail closed", () => {
  const tar = buildTarEntriesBuffer([
    { path: "weird", content: "x", typeflag: "7" },
  ]);
  const parsed = parseTarBuffer(tar);
  assert.ok(parsed.violations.some((v) => /不支持的 tar 类型/.test(v.reason)));
});

test("readNpmPackTgz 解析 npm 风格 package/ 前缀", () => {
  const tgz = buildNpmPackTgzFixture([
    {
      path: "package.json",
      content: '{"name":"@henlii/pi-deck","version":"0.1.0","bin":{"pi-deck":"bin/pi-deck.js"}}',
    },
    { path: "bin/pi-deck.js", content: "ok" },
  ]);
  const read = readNpmPackTgz(tgz);
  assert.ok(read.files.some((f) => f.path === "package.json"));
  assert.equal(read.packageJson?.name, "@henlii/pi-deck");
});

test("损坏 gzip fail closed", () => {
  const result = auditReleaseTgz({ tgzPathOrBuffer: Buffer.from("not-a-gzip") });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => /gzip|解压/.test(v.reason)));
});

test("verifyTarHeaderChecksum 对合法 header 通过", () => {
  const tar = buildTarEntriesBuffer([{ path: "package.json", content: "{}" }]);
  const header = tar.subarray(0, 512);
  const v = verifyTarHeaderChecksum(header);
  assert.equal(v.ok, true);
});
