import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { sessionService } = await jiti.import("@/lib/session-service");
const { POST: agentPost } = await jiti.import("../app/api/agent/[id]/route.ts");
const { GET: eventsGet } = await jiti.import("../app/api/agent/[id]/events/route.ts");
const { PATCH: sessionPatch, DELETE: sessionDelete } = await jiti.import("../app/api/sessions/[id]/route.ts");
const { POST: autoNamePost } = await jiti.import("../app/api/sessions/[id]/auto-name/route.ts");

const params = { params: Promise.resolve({ id: "readonly-session" }) };
const request = (body) => new Request("http://localhost/api/test", {
  method: body === undefined ? "GET" : "POST",
  ...(body === undefined ? {} : {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }),
});

async function assertReadOnly(response) {
  const body = await response.json();
  assert.equal(response.status, 403, JSON.stringify(body));
  assert.deepEqual(body, { error: "Subagent sessions are read-only" });
}

test("只读 session 的写 route 直接返回 403 且不进入写路径", async () => {
  const originalIsReadOnly = sessionService.isReadOnly;
  const originalSend = sessionService.send;
  const originalStart = sessionService.start;
  let writes = 0;
  sessionService.isReadOnly = async () => true;
  sessionService.send = async () => { writes++; throw new Error("写路径不应执行"); };
  sessionService.start = async () => { writes++; throw new Error("写路径不应执行"); };

  try {
    await assertReadOnly(await agentPost(request({ type: "prompt", message: "test" }), params));
    await assertReadOnly(await eventsGet(new Request("http://localhost/api/test"), params));
    await assertReadOnly(await sessionPatch(request({ name: "new name" }), params));
    await assertReadOnly(await sessionDelete(new Request("http://localhost/api/test", { method: "DELETE" }), params));
    await assertReadOnly(await autoNamePost(new Request("http://localhost/api/test", { method: "POST" }), params));
    assert.equal(writes, 0);
  } finally {
    sessionService.isReadOnly = originalIsReadOnly;
    sessionService.send = originalSend;
    sessionService.start = originalStart;
  }
});

test("events GET 不会把门禁内部异常伪装成 403", async () => {
  const originalIsReadOnly = sessionService.isReadOnly;
  sessionService.isReadOnly = async () => { throw new Error("门禁内部错误"); };
  try {
    const response = await eventsGet(new Request("http://localhost/api/test"), params);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Error: 门禁内部错误" });
  } finally {
    sessionService.isReadOnly = originalIsReadOnly;
  }
});
