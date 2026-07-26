import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const load = () => import("./file-save.ts");
const allowed = (target, roots) => [...roots].some((root) => target === root || target.startsWith(`${root}${path.sep}`));
const binary = (target) => /\.png$/i.test(target) ? "image/png" : null;
const save = (fn, options) => fn({ ...options, isAllowed: allowed, getBinaryMime: binary });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-save-"));
  const file = path.join(root, "note.txt"); fs.writeFileSync(file, "old");
  return { root, file, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("校验 denylist、环境文件和特殊临时名", async () => {
  const { validateSaveName } = await load();
  assert.match(validateSaveName("/x/.git/a"), /受保护/);
  assert.match(validateSaveName("/x/.env"), /环境/);
  assert.equal(validateSaveName("/x/.env.example"), null);
  assert.match(validateSaveName("/x/.pi-save-test"), /受保护/);
});

test("限制 UTF-8 字节大小并原子替换且保留 mode", async () => {
  const { saveFile, FileSaveError, MAX_SAVE_BYTES } = await load(); const f = fixture();
  try {
    fs.chmodSync(f.file, 0o640); const s = fs.statSync(f.file);
    const result = save(saveFile, { target: f.file, cwd: f.root, allowedRoots: new Set([f.root]), content: "新内容", baseline: { mtimeMs: s.mtimeMs, size: s.size } });
    assert.equal(fs.readFileSync(f.file, "utf8"), "新内容"); assert.equal(fs.statSync(f.file).mode & 0o777, 0o640); assert.equal(result.size, Buffer.byteLength("新内容"));
    assert.throws(() => save(saveFile, { target: f.file, cwd: f.root, allowedRoots: new Set([f.root]), content: "x".repeat(MAX_SAVE_BYTES + 1), baseline: { mtimeMs: result.mtimeMs, size: result.size } }), (e) => e instanceof FileSaveError && e.code === "too-large");
  } finally { f.clean(); }
});

test("严格 baseline 冲突不覆盖和跨 cwd 拒绝", async () => {
  const { saveFile, FileSaveError } = await load(); const f = fixture(); const other = fs.mkdtempSync(path.join(os.tmpdir(), "pi-save-other-"));
  try {
    const s = fs.statSync(f.file); fs.writeFileSync(f.file, "new externally");
    assert.throws(() => save(saveFile, { target: f.file, cwd: f.root, allowedRoots: new Set([f.root]), content: "bad", baseline: { mtimeMs: s.mtimeMs, size: s.size } }), (e) => e instanceof FileSaveError && e.code === "conflict");
    fs.writeFileSync(f.file, "new externally");
    assert.equal(save(saveFile, { target: f.file, cwd: f.root, allowedRoots: new Set([f.root]), content: "allowed", baseline: { mtimeMs: fs.statSync(f.file).mtimeMs, size: fs.statSync(f.file).size } }).size, 7);
    const outside = path.join(other, "x.txt"); fs.writeFileSync(outside, "x"); const osStat = fs.statSync(outside);
    assert.throws(() => save(saveFile, { target: outside, cwd: f.root, allowedRoots: new Set([f.root, other]), content: "bad", baseline: { mtimeMs: osStat.mtimeMs, size: osStat.size } }), (e) => e.code === "forbidden");
  } finally { f.clean(); fs.rmSync(other, { recursive: true, force: true }); }
});

test("父目录 symlink 和临时文件清理", async () => {
  const { saveFile } = await load(); const f = fixture(); const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-save-out-"));
  try {
    fs.symlinkSync(outside, path.join(f.root, "link")); fs.writeFileSync(path.join(outside, "x.txt"), "x"); const s = fs.statSync(path.join(outside, "x.txt"));
    assert.throws(() => save(saveFile, { target: path.join(f.root, "link/x.txt"), cwd: f.root, allowedRoots: new Set([f.root, outside]), content: "y", baseline: { mtimeMs: s.mtimeMs, size: s.size } }), (e) => e.code === "forbidden");
    assert.equal(fs.readdirSync(f.root).some((name) => name.startsWith(".pi-save-")), false);
  } finally { f.clean(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test("拒绝 lone surrogate、已知 PNG，允许合法 pair 和超过 1MiB 的旧文件覆盖", async () => {
  const { saveFile, FileSaveError, isStrictPathChild } = await load(); const f = fixture();
  try {
    const baseline = fs.statSync(f.file);
    assert.throws(() => save(saveFile, { target: f.file, cwd: f.root, allowedRoots: new Set([f.root]), content: "\ud800", baseline }), (e) => e instanceof FileSaveError && e.code === "bad-request");
    const pair = "😀"; assert.equal(save(saveFile, { target: f.file, cwd: f.root, allowedRoots: new Set([f.root]), content: pair, baseline: { mtimeMs: fs.statSync(f.file).mtimeMs, size: fs.statSync(f.file).size } }).size, 4);
    const png = path.join(f.root, "image.png"); fs.writeFileSync(png, Buffer.from([137, 80, 78, 71]));
    assert.throws(() => save(saveFile, { target: png, cwd: f.root, allowedRoots: new Set([f.root]), content: "x", baseline: { mtimeMs: fs.statSync(png).mtimeMs, size: 4 } }), (e) => e.code === "bad-request");
    fs.writeFileSync(f.file, Buffer.alloc(2 * 1024 * 1024, 65));
    assert.equal(save(saveFile, { target: f.file, cwd: f.root, allowedRoots: new Set([f.root]), content: "small", baseline: { mtimeMs: fs.statSync(f.file).mtimeMs, size: 2 * 1024 * 1024 } }).size, 5);
    assert.equal(isStrictPathChild("C:\\Work\\Repo\\File.txt", "c:\\work\\repo", true), true);
  } finally { f.clean(); }
});

test("目标不存在映射 404，写入或 rename 失败清理临时文件", async () => {
  const { saveFile, FileSaveError } = await load(); const f = fixture();
  const missing = path.join(f.root, "missing.txt");
  assert.throws(() => save(saveFile, { target: missing, cwd: f.root, allowedRoots: new Set([f.root]), content: "x", baseline: { mtimeMs: 0, size: 0 } }), (e) => e instanceof FileSaveError && e.code === "not-found");
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = () => { const error = new Error("rename failed"); error.code = "EIO"; throw error; };
    const stat = fs.statSync(f.file);
    assert.throws(() => save(saveFile, { target: f.file, cwd: f.root, allowedRoots: new Set([f.root]), content: "failed", baseline: { mtimeMs: stat.mtimeMs, size: stat.size } }), /rename failed/);
    assert.equal(fs.readdirSync(f.root).some((name) => name.startsWith(".pi-save-")), false);
  } finally { fs.renameSync = originalRename; f.clean(); }
});
