import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./chat-attachments.ts");

test("sanitizeAttachmentFileName：去掉路径与空字节", () => {
  assert.equal(mod.sanitizeAttachmentFileName("../../etc/passwd"), "passwd");
  assert.equal(mod.sanitizeAttachmentFileName("a\\b\\c.txt"), "c.txt");
  assert.equal(mod.sanitizeAttachmentFileName(""), "file");
  assert.equal(mod.sanitizeAttachmentFileName("..."), "file");
});

test("uniqueAttachmentFileName：含时间戳与原名且不冲突风格", () => {
  const a = mod.uniqueAttachmentFileName("report.pdf", 1_700_000_000_000);
  const b = mod.uniqueAttachmentFileName("report.pdf", 1_700_000_000_000);
  assert.match(a, /report\.pdf$/);
  assert.match(b, /report\.pdf$/);
  // 同时间戳仍靠 uuid 前缀区分
  assert.notEqual(a, b);
});

test("saveChatAttachmentBytes：写入 agentDir/pidance-attachments 并返回绝对路径", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-att-"));
  try {
    const saved = mod.saveChatAttachmentBytes("hello.txt", Buffer.from("hello"), root);
    assert.ok(saved.path.includes("pidance-attachments"));
    assert.ok(saved.path.endsWith(saved.storedName));
    assert.equal(saved.name, "hello.txt");
    assert.equal(saved.size, 5);
    assert.equal(readFileSync(saved.path, "utf8"), "hello");
    assert.ok(existsSync(join(root, "pidance-attachments")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getChatAttachmentsDir：路径形状", () => {
  assert.equal(mod.getChatAttachmentsDir("/tmp/agent"), "/tmp/agent/pidance-attachments");
});
