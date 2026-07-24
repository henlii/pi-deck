import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeFilePathSlashes, normalizeSlashes, safeDecode, shortenPath } = await jiti.import("./file-paths.ts");

test("safeDecode 在 URI 解码失败时保留原值", () => {
  assert.equal(safeDecode("%E0%A4%A"), "%E0%A4%A");
  assert.equal(safeDecode("hello%20world"), "hello world");
});

test("normalizeFilePathSlashes 处理 Windows drive 与 UNC 路径", () => {
  assert.equal(normalizeFilePathSlashes("C:\\Users\\pi\\file.txt"), "C:/Users/pi/file.txt");
  assert.equal(normalizeFilePathSlashes("\\\\server\\share\\file.txt"), "//server/share/file.txt");
});

test("normalizeFilePathSlashes 不改变 POSIX 路径中的反斜杠", () => {
  assert.equal(normalizeFilePathSlashes("/tmp/a\\b.txt"), "/tmp/a\\b.txt");
});

test("normalizeSlashes 无条件归一化反斜杠", () => {
  assert.equal(normalizeSlashes("/tmp/a\\b.txt"), "/tmp/a/b.txt");
});

test("shortenPath 缩写 home 路径", () => {
  assert.equal(shortenPath("/home/alice/project"), "~/project");
  assert.equal(shortenPath("/Users/alice/project"), "~/project");
  assert.equal(shortenPath("/opt/project"), "/opt/project");
});
