import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./lens-diagnostics.ts");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

test("slugifyCwd：路径净化", () => {
  const slug = mod.slugifyCwd("/root/works/open/pi-deck");
  assert.equal(slug, "root-works-open-pi-deck");
});

test("mapLspSeverity：数字与字符串", () => {
  assert.equal(mod.mapLspSeverity(1), "error");
  assert.equal(mod.mapLspSeverity(2), "warning");
  assert.equal(mod.mapLspSeverity(3), "info");
  assert.equal(mod.mapLspSeverity(4), "hint");
  assert.equal(mod.mapLspSeverity("error"), "error");
  assert.equal(mod.mapLspSeverity("unknown"), "warning");
});

test("parseLspWorkspaceCache：过滤空项、按错误优先、行号 1-based", () => {
  const raw = {
    version: 1,
    entries: {
      "/proj/a.ts": {
        scannedAt: 100,
        diagnostics: [
          {
            message: "warn here",
            severity: 2,
            source: "eslint",
            code: "no-unused",
            range: { start: { line: 9, character: 2 }, end: { line: 9, character: 5 } },
          },
          {
            message: "error here",
            severity: 1,
            source: "tsc",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        ],
      },
      "/proj/b.ts": {
        scannedAt: 200,
        diagnostics: [],
      },
      "/proj/c.ts": {
        scannedAt: 150,
        diagnostics: [{ message: "  ", severity: 1 }],
      },
    },
  };
  const { files, scannedAt } = mod.parseLspWorkspaceCache(raw, "/proj");
  assert.equal(scannedAt, 200);
  assert.equal(files.length, 1);
  assert.equal(files[0].filePath, "/proj/a.ts");
  assert.equal(files[0].displayPath, "a.ts");
  assert.equal(files[0].count, 2);
  // error 优先
  assert.equal(files[0].items[0].severity, "error");
  assert.equal(files[0].items[0].line, 1);
  assert.equal(files[0].items[1].severity, "warning");
  assert.equal(files[0].items[1].line, 10);
});

test("listLensDiagnostics：读取 fixture 缓存 + quality 尾部", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-diag-"));
  try {
    const cwd = path.join(root, "proj");
    const dataDir = path.join(root, "data");
    const cachePath = path.join(dataDir, "cache", "lsp-workspace-diagnostics.json");
    writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        entries: {
          [path.join(cwd, "src/app.ts")]: {
            scannedAt: 999,
            diagnostics: [
              {
                message: "Unused var",
                severity: 2,
                source: "ast-grep",
                code: "unused",
                range: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } },
              },
            ],
          },
        },
      }),
    );
    const qualityPath = path.join(root, "quality.jsonl");
    writeFile(
      qualityPath,
      [
        JSON.stringify({
          timestamp: "2026-01-01T00:00:00Z",
          filePath: path.join(cwd, "src/app.ts"),
          displayPath: "src/app.ts",
          line: 5,
          severity: "warning",
          tool: "fact-rules",
          rule: "high-complexity",
          message: "too complex",
        }),
        "{bad",
        JSON.stringify({
          filePath: path.join(cwd, "src/other.ts"),
          message: "latest warning",
          severity: "info",
          tool: "typos",
        }),
      ].join("\n") + "\n",
    );

    const snap = mod.listLensDiagnostics({
      cwd,
      dataDir,
      qualityLogPath: qualityPath,
      env: {},
      homedir: () => root,
    });

    assert.equal(snap.cacheAvailable, true);
    assert.equal(snap.counts.total, 1);
    assert.equal(snap.counts.files, 1);
    assert.equal(snap.counts.bySeverity.warning, 1);
    assert.equal(snap.files[0].items[0].message, "Unused var");
    assert.equal(snap.files[0].items[0].line, 5);
    assert.equal(snap.qualityAvailable, true);
    // 从尾部取，最新在前
    assert.equal(snap.qualityWarnings[0].message, "latest warning");
    assert.ok(snap.qualityWarnings.some((w) => w.message === "too complex"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listLensDiagnostics：缺失缓存安全空态", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-empty-"));
  try {
    const cwd = path.join(root, "proj");
    fs.mkdirSync(cwd, { recursive: true });
    const snap = mod.listLensDiagnostics({
      cwd,
      dataDir: path.join(root, "missing-data"),
      qualityLogPath: path.join(root, "missing-quality.jsonl"),
      env: {},
      homedir: () => root,
    });
    assert.equal(snap.cacheAvailable, false);
    assert.equal(snap.counts.total, 0);
    assert.deepEqual(snap.files, []);
    assert.equal(snap.qualityAvailable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listLensDiagnostics：symlink 缓存拒绝", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-sym-"));
  try {
    const cwd = path.join(root, "proj");
    const dataDir = path.join(root, "data");
    const cacheDir = path.join(dataDir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const outside = path.join(root, "outside.json");
    writeFile(outside, JSON.stringify({ version: 1, entries: {} }));
    fs.symlinkSync(outside, path.join(cacheDir, "lsp-workspace-diagnostics.json"));
    const snap = mod.listLensDiagnostics({
      cwd,
      dataDir,
      qualityLogPath: path.join(root, "q.jsonl"),
      env: {},
      homedir: () => root,
    });
    assert.equal(snap.cacheAvailable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveLensDataDir：legacy .pi-lens 优先（无 PILENS_DATA_DIR）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-legacy-"));
  try {
    const cwd = path.join(root, "proj");
    const legacy = path.join(cwd, ".pi-lens");
    fs.mkdirSync(legacy, { recursive: true });
    const dir = mod.resolveLensDataDir(cwd, {
      env: {},
      homedir: () => root,
    });
    assert.equal(path.resolve(dir), path.resolve(legacy));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
