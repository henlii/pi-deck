import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./file-types.ts");
}

test("detects image, audio, video, and document preview paths", async () => {
  const {
    getAudioMime,
    getDocumentMime,
    getImageMime,
    getVideoMime,
    isAudioPath,
    isDocumentPreviewPath,
    isImagePath,
    isVideoPath,
  } = await loadSubject();

  assert.equal(getImageMime("/tmp/screenshot.PNG"), "image/png");
  assert.equal(getAudioMime("C:\\Users\\me\\voice.OPUS"), "audio/ogg");
  assert.equal(getVideoMime("/tmp/clip.MP4"), "video/mp4");
  assert.equal(getVideoMime("/tmp/clip.webm"), "video/webm");
  assert.equal(getDocumentMime("/tmp/report.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(isImagePath("/tmp/screenshot.PNG"), true);
  assert.equal(isAudioPath("C:\\Users\\me\\voice.OPUS"), true);
  assert.equal(isVideoPath("/tmp/clip.mp4"), true);
  assert.equal(isVideoPath("/tmp/clip.webm"), true);
  assert.equal(isDocumentPreviewPath("/tmp/report.pdf"), true);
  assert.equal(isDocumentPreviewPath("/tmp/report.txt"), false);
});

test("extracts extensions from mixed path styles", async () => {
  const { documentPreviewKind, getFileExt } = await loadSubject();

  assert.equal(getFileExt("/tmp/archive.tar.gz"), "gz");
  assert.equal(getFileExt("C:\\Users\\me\\photo.AVIF"), "avif");
  assert.equal(documentPreviewKind("/tmp/manual.PDF"), "pdf");
  assert.equal(documentPreviewKind("/tmp/manual.md"), null);
});

test("extractMediaPathsFromText：从消息正文抽取图/音/视频路径", async () => {
  const { extractMediaPathsFromText } = await loadSubject();
  const text = [
    "以下文件已上传到项目目录，请按需用工具读取：",
    "- `/root/works/demo/photo.png`",
    "- `/root/works/demo/voice.mp3`",
    "- `/root/works/demo/clip.mp4`",
    "普通说明 /tmp/notes.txt 不应被当作媒体",
  ].join("\n");
  const media = extractMediaPathsFromText(text);
  assert.deepEqual(media.images, ["/root/works/demo/photo.png"]);
  assert.deepEqual(media.audio, ["/root/works/demo/voice.mp3"]);
  assert.deepEqual(media.video, ["/root/works/demo/clip.mp4"]);
});
