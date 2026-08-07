import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const load = () => jiti.import("./file-ops.ts");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-ops-"));
  return {
    root,
    clean: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("validateEntryName 拒绝路径分隔、受保护名与环境文件", async () => {
  const { validateEntryName } = await load();
  assert.match(validateEntryName(""), /Invalid/);
  assert.match(validateEntryName(".."), /Invalid/);
  assert.match(validateEntryName("a/b"), /path/);
  assert.match(validateEntryName("node_modules"), /Protected/);
  assert.match(validateEntryName(".env"), /Environment/);
  assert.equal(validateEntryName("note.txt"), null);
  assert.equal(validateEntryName(".env.example"), null);
});

test("createEmptyFile / createDirectory 成功并拒绝覆盖与越权", async () => {
  const {
    createEmptyFile,
    createDirectory,
    FileOpsError,
  } = await load();
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-ops-out-"));
  try {
    const file = createEmptyFile(f.root, "a.txt", new Set([f.root]));
    assert.equal(fs.readFileSync(file.path, "utf8"), "");
    assert.throws(
      () => createEmptyFile(f.root, "a.txt", new Set([f.root])),
      (e) => e instanceof FileOpsError && e.code === "conflict",
    );

    const dir = createDirectory(f.root, "subdir", new Set([f.root]));
    assert.equal(fs.statSync(dir.path).isDirectory(), true);
    assert.throws(
      () => createDirectory(f.root, "subdir", new Set([f.root])),
      (e) => e instanceof FileOpsError && e.code === "conflict",
    );

    assert.throws(
      () => createEmptyFile(outside, "x.txt", new Set([f.root])),
      (e) => e instanceof FileOpsError && e.code === "forbidden",
    );
  } finally {
    f.clean();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("renameEntry 同目录改名并拒绝冲突/symlink", async () => {
  const { renameEntry, FileOpsError } = await load();
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-ops-out2-"));
  try {
    const src = path.join(f.root, "old.txt");
    fs.writeFileSync(src, "hi");
    const renamed = renameEntry(src, "new.txt", new Set([f.root]));
    assert.equal(path.basename(renamed.path), "new.txt");
    assert.equal(fs.readFileSync(renamed.path, "utf8"), "hi");
    assert.equal(fs.existsSync(src), false);

    fs.writeFileSync(path.join(f.root, "taken.txt"), "x");
    assert.throws(
      () => renameEntry(renamed.path, "taken.txt", new Set([f.root])),
      (e) => e instanceof FileOpsError && e.code === "conflict",
    );

    fs.symlinkSync(outside, path.join(f.root, "link"));
    assert.throws(
      () => renameEntry(path.join(f.root, "link"), "link2", new Set([f.root])),
      (e) => e instanceof FileOpsError && e.code === "forbidden",
    );
  } finally {
    f.clean();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
