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
const load = () => jiti.import("./file-read.ts");

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-read-"));
  const root = path.join(tmp, "root");
  const rootB = path.join(tmp, "rootB");
  const outside = path.join(tmp, "outside");
  const outsideSub = path.join(outside, "sub");
  fs.mkdirSync(root);
  fs.mkdirSync(rootB);
  fs.mkdirSync(outside);
  fs.mkdirSync(outsideSub);
  const note = path.join(root, "note.txt");
  fs.writeFileSync(note, "hello");
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(secret, "top secret");
  const inner = path.join(outsideSub, "inner.txt");
  fs.writeFileSync(inner, "inner secret");
  const bFile = path.join(rootB, "b.txt");
  fs.writeFileSync(bFile, "from rootB");
  return {
    tmp, root, rootB, outside, outsideSub, note, secret, inner, bFile,
    clean: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

test("根内普通文件解析通过（ok，realPath 与词法路径一致）", async () => {
  const { resolveReadablePath } = await load();
  const f = fixture();
  try {
    const r = resolveReadablePath(f.note, new Set([f.root]));
    assert.equal(r.kind, "ok");
    assert.equal(r.realPath, f.note);
    assert.equal(r.stat.isFile(), true);
    assert.equal(r.stat.size, 5);
  } finally { f.clean(); }
});

test("根目录本身可通过（列表根目录语义，包含相等关系）", async () => {
  const { resolveReadablePath } = await load();
  const f = fixture();
  try {
    const r = resolveReadablePath(f.root, new Set([f.root]));
    assert.equal(r.kind, "ok");
    assert.equal(r.realPath, f.root);
    assert.equal(r.stat.isDirectory(), true);
  } finally { f.clean(); }
});

test("根内文件 symlink 指向根外文件 → outside-roots（路由层拒绝）", async () => {
  const { resolveReadablePath } = await load();
  const f = fixture();
  try {
    const link = path.join(f.root, "leak.txt");
    fs.symlinkSync(f.secret, link);
    const r = resolveReadablePath(link, new Set([f.root]));
    assert.equal(r.kind, "outside-roots");
    assert.equal(r.realPath, f.secret);
  } finally { f.clean(); }
});

test("根内目录 symlink 指向根外目录 → outside-roots（读与列表均拒绝）", async () => {
  const { resolveReadablePath } = await load();
  const f = fixture();
  try {
    const dirLink = path.join(f.root, "outside-link");
    fs.symlinkSync(f.outside, dirLink, "dir");
    // 读目录内文件
    const fileR = resolveReadablePath(path.join(dirLink, "secret.txt"), new Set([f.root]));
    assert.equal(fileR.kind, "outside-roots");
    assert.equal(fileR.realPath, f.secret);
    // 列表目录本身
    const listR = resolveReadablePath(dirLink, new Set([f.root]));
    assert.equal(listR.kind, "outside-roots");
    assert.equal(listR.realPath, f.outside);
    assert.equal(listR.stat.isDirectory(), true);
  } finally { f.clean(); }
});

test("多级 symlink 链解析到根外 → outside-roots", async () => {
  const { resolveReadablePath } = await load();
  const f = fixture();
  try {
    // l1 -> l2 -> outside/sub/inner.txt（symlink 指向 symlink）
    const l1 = path.join(f.root, "l1.txt");
    const l2 = path.join(f.root, "l2.txt");
    fs.symlinkSync(f.inner, l2);
    fs.symlinkSync(l2, l1);
    const r = resolveReadablePath(l1, new Set([f.root]));
    assert.equal(r.kind, "outside-roots");
    assert.equal(r.realPath, f.inner);
    // 多级目录链：root/dir-link/sub/inner.txt（dir-link -> outside）
    const dirLink = path.join(f.root, "dir-link");
    fs.symlinkSync(f.outside, dirLink, "dir");
    const multi = resolveReadablePath(path.join(dirLink, "sub", "inner.txt"), new Set([f.root]));
    assert.equal(multi.kind, "outside-roots");
    assert.equal(multi.realPath, f.inner);
  } finally { f.clean(); }
});

test("根内目录 symlink 指向根内目标 → ok（产品允许语义）", async () => {
  const { resolveReadablePath } = await load();
  const f = fixture();
  try {
    const dir = path.join(f.root, "real-dir");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    const dirLink = path.join(f.root, "dir-link");
    fs.symlinkSync(dir, dirLink, "dir");
    const r = resolveReadablePath(path.join(dirLink, "a.txt"), new Set([f.root]));
    assert.equal(r.kind, "ok");
    assert.equal(r.realPath, path.join(dir, "a.txt"));
  } finally { f.clean(); }
});

test("另一个合法根的 symlink → ok（目标位于其他授权根内）", async () => {
  const { resolveReadablePath } = await load();
  const f = fixture();
  try {
    const link = path.join(f.root, "b-link.txt");
    fs.symlinkSync(f.bFile, link);
    const r = resolveReadablePath(link, new Set([f.root, f.rootB]));
    assert.equal(r.kind, "ok");
    assert.equal(r.realPath, f.bFile);
    // 目标根不在授权集内 → outside-roots
    const denied = resolveReadablePath(link, new Set([f.root]));
    assert.equal(denied.kind, "outside-roots");
  } finally { f.clean(); }
});

test("不存在的路径 → not-found", async () => {
  const { resolveReadablePath } = await load();
  const f = fixture();
  try {
    const r = resolveReadablePath(path.join(f.root, "missing.txt"), new Set([f.root]));
    assert.equal(r.kind, "not-found");
  } finally { f.clean(); }
});

test("悬空 symlink → not-found", async () => {
  const { resolveReadablePath } = await load();
  const f = fixture();
  try {
    const dangling = path.join(f.root, "dangling.txt");
    fs.symlinkSync(path.join(f.outside, "nope.txt"), dangling);
    const r = resolveReadablePath(dangling, new Set([f.root]));
    assert.equal(r.kind, "not-found");
  } finally { f.clean(); }
});

test("会话引用豁免门禁：字面无符号链接重定向才算放行", async () => {
  const { resolveReadablePath, isNoSymlinkRedirection } = await load();
  const f = fixture();
  try {
    // 根外字面路径（无符号链接）→ outside-roots 且 isNoSymlinkRedirection 通过
    const outsideR = resolveReadablePath(f.secret, new Set([f.root]));
    assert.equal(outsideR.kind, "outside-roots");
    assert.equal(isNoSymlinkRedirection(f.secret, outsideR.realPath), true);
    // 根内 symlink 指向根外 → realpath 与字面路径不一致 → 不放行
    const link = path.join(f.root, "leak.txt");
    fs.symlinkSync(f.secret, link);
    const linkR = resolveReadablePath(link, new Set([f.root]));
    assert.equal(linkR.kind, "outside-roots");
    assert.equal(isNoSymlinkRedirection(link, linkR.realPath), false);
  } finally { f.clean(); }
});

test("openRegularFileReadonly：普通文件可读；symlink 被 O_NOFOLLOW 拒绝", async () => {
  const { openRegularFileReadonly } = await load();
  const f = fixture();
  try {
    const fd = openRegularFileReadonly(f.note);
    try {
      assert.equal(fs.readFileSync(fd, "utf8"), "hello");
    } finally {
      fs.closeSync(fd);
    }
    const link = path.join(f.root, "link.txt");
    fs.symlinkSync(f.secret, link);
    assert.throws(() => openRegularFileReadonly(link), (e) => e.code === "ELOOP");
    // 目录也不可读（fstat 复核）
    assert.throws(() => openRegularFileReadonly(f.root));
  } finally { f.clean(); }
});

// ---------- route 集成层 ----------

const { GET } = await jiti.import("../app/api/files/[...path]/route.ts");
const { NextRequest } = await jiti.import("next/server");

function apiUrl(filePath, type) {
  const segments = filePath.split("/").filter(Boolean).join("/");
  return `http://localhost/api/files/${segments}?type=${type}`;
}

async function withRoots(roots, fn) {
  globalThis.__piAllowedRootsCache = { roots: new Set(roots), expiresAt: Date.now() + 60_000 };
  try {
    return await fn();
  } finally {
    delete globalThis.__piAllowedRootsCache;
  }
}

async function getJson(response) {
  const body = await response.json();
  return { status: response.status, body };
}

test("route：根内普通文件 read 200 返回内容", async () => {
  const f = fixture();
  try {
    await withRoots([f.root], async () => {
      const { status, body } = await getJson(await GET(new NextRequest(apiUrl(f.note, "read")), { params: Promise.resolve({ path: f.note.split("/").filter(Boolean) }) }));
      assert.equal(status, 200);
      assert.equal(body.content, "hello");
      assert.equal(body.language, "text");
    });
  } finally { f.clean(); }
});

test("route：根内文件 symlink 指向根外 → read/meta/download 403", async () => {
  const f = fixture();
  try {
    const link = path.join(f.root, "leak.txt");
    fs.symlinkSync(f.secret, link);
    const segments = link.split("/").filter(Boolean);
    await withRoots([f.root], async () => {
      for (const type of ["read", "meta", "download"]) {
        const { status, body } = await getJson(await GET(new NextRequest(apiUrl(link, type)), { params: Promise.resolve({ path: segments }) }));
        assert.equal(status, 403, `${type} 应拒绝 symlink 越界`);
        assert.equal(body.error, "Access denied");
      }
    });
  } finally { f.clean(); }
});

test("route：目录 symlink 指向根外 → list 403；根内目录 list 200", async () => {
  const f = fixture();
  try {
    const dirLink = path.join(f.root, "outside-link");
    fs.symlinkSync(f.outside, dirLink, "dir");
    await withRoots([f.root], async () => {
      const denied = await getJson(await GET(new NextRequest(apiUrl(dirLink, "list")), { params: Promise.resolve({ path: dirLink.split("/").filter(Boolean) }) }));
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error, "Access denied");
      const ok = await getJson(await GET(new NextRequest(apiUrl(f.root, "list")), { params: Promise.resolve({ path: f.root.split("/").filter(Boolean) }) }));
      assert.equal(ok.status, 200);
      // symlink 目录仅作条目分类展示（不泄漏内容）；进入它才会被拒绝
      assert.deepEqual(ok.body.entries.map((e) => e.name), ["outside-link", "note.txt"]);
    });
  } finally { f.clean(); }
});

test("route：多级 symlink 越界 → read 403；不存在 → 404；列表文件 → 400", async () => {
  const f = fixture();
  try {
    const l1 = path.join(f.root, "l1.txt");
    const l2 = path.join(f.root, "l2.txt");
    fs.symlinkSync(f.secret, l2);
    fs.symlinkSync(l2, l1);
    await withRoots([f.root], async () => {
      const leaked = await getJson(await GET(new NextRequest(apiUrl(l1, "read")), { params: Promise.resolve({ path: l1.split("/").filter(Boolean) }) }));
      assert.equal(leaked.status, 403);
      const missing = await getJson(await GET(new NextRequest(apiUrl(path.join(f.root, "nope.txt"), "read")), { params: Promise.resolve({ path: path.join(f.root, "nope.txt").split("/").filter(Boolean) }) }));
      assert.equal(missing.status, 404);
      const notDir = await getJson(await GET(new NextRequest(apiUrl(f.note, "list")), { params: Promise.resolve({ path: f.note.split("/").filter(Boolean) }) }));
      assert.equal(notDir.status, 400);
    });
  } finally { f.clean(); }
});
