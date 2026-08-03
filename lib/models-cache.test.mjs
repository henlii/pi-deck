import assert from "node:assert/strict";
import test from "node:test";

import { getOrCreateModelRuntime, invalidateModelsCache, loadModelsWithCache } from "./models-cache.ts";

function modelsData(id) {
  return {
    models: { [`provider:${id}`]: id },
    modelList: [{ id, name: id, provider: "provider" }],
    defaultModel: null,
    thinkingLevels: {},
    thinkingLevelMaps: {},
  };
}

test("caches model data independently for each cwd", async () => {
  invalidateModelsCache();
  let firstLoads = 0;
  let secondLoads = 0;

  const first = await loadModelsWithCache("/first", async () => {
    firstLoads += 1;
    return modelsData("first");
  });
  await loadModelsWithCache("/second", async () => {
    secondLoads += 1;
    return modelsData("second");
  });
  const firstAgain = await loadModelsWithCache("/first", async () => {
    firstLoads += 1;
    return modelsData("replacement");
  });

  assert.deepEqual(firstAgain, first);
  assert.equal(firstLoads, 1);
  assert.equal(secondLoads, 1);
});

test("shares one loader between concurrent requests for the same cwd", async () => {
  invalidateModelsCache();
  let loads = 0;
  let finishLoad;
  const loader = () => {
    loads += 1;
    return new Promise((resolve) => { finishLoad = resolve; });
  };

  const first = loadModelsWithCache("/shared", loader);
  const second = loadModelsWithCache("/shared", loader);
  await Promise.resolve();

  assert.equal(loads, 1);
  finishLoad(modelsData("shared"));
  assert.deepEqual(await second, await first);
});

test("does not cache a stale load that finishes after invalidation", async () => {
  invalidateModelsCache();
  let finishOldLoad;
  const oldLoad = loadModelsWithCache("/stale", () => new Promise((resolve) => { finishOldLoad = resolve; }));
  await Promise.resolve();

  invalidateModelsCache();
  let freshLoads = 0;
  const fresh = await loadModelsWithCache("/stale", async () => {
    freshLoads += 1;
    return modelsData("fresh");
  });
  finishOldLoad(modelsData("stale"));
  await oldLoad;

  const cached = await loadModelsWithCache("/stale", async () => {
    freshLoads += 1;
    return modelsData("unexpected");
  });
  assert.deepEqual(cached, fresh);
  assert.equal(freshLoads, 1);
});

test("retries after a model load fails", async () => {
  invalidateModelsCache();
  await assert.rejects(
    loadModelsWithCache("/failed", async () => { throw new Error("load failed"); }),
    /load failed/,
  );

  let retries = 0;
  const fresh = await loadModelsWithCache("/failed", async () => {
    retries += 1;
    return modelsData("fresh");
  });
  assert.deepEqual(fresh, modelsData("fresh"));
  assert.equal(retries, 1);
});

// ── 进程级 ModelRuntime 复用（getOrCreateModelRuntime）──

const fakeRuntime = (id) => ({ id });

test("reuses one ModelRuntime per agentDir", async () => {
  invalidateModelsCache();
  let creates = 0;
  const create = async () => {
    creates += 1;
    return fakeRuntime("runtime");
  };
  const first = await getOrCreateModelRuntime("/agent", create);
  const second = await getOrCreateModelRuntime("/agent", create);
  assert.equal(first, second);
  assert.equal(creates, 1);
});

test("keeps ModelRuntime separate per agentDir", async () => {
  invalidateModelsCache();
  let creates = 0;
  const createA = async () => { creates += 1; return fakeRuntime("a"); };
  const createB = async () => { creates += 1; return fakeRuntime("b"); };
  const a = await getOrCreateModelRuntime("/agent-a", createA);
  const b = await getOrCreateModelRuntime("/agent-b", createB);
  assert.notEqual(a, b);
  assert.equal(creates, 2);
  assert.equal(await getOrCreateModelRuntime("/agent-a", createA), a);
});

test("coalesces concurrent ModelRuntime creation for the same agentDir", async () => {
  invalidateModelsCache();
  let creates = 0;
  let finishCreate;
  const create = () => {
    creates += 1;
    return new Promise((resolve) => { finishCreate = resolve; });
  };
  const first = getOrCreateModelRuntime("/agent", create);
  const second = getOrCreateModelRuntime("/agent", create);
  await Promise.resolve();

  assert.equal(creates, 1);
  finishCreate(fakeRuntime("runtime"));
  assert.equal(await first, await second);
});

test("invalidateModelsCache clears the ModelRuntime cache", async () => {
  invalidateModelsCache();
  let creates = 0;
  const create = async () => {
    creates += 1;
    return fakeRuntime(`runtime-${creates}`);
  };
  const first = await getOrCreateModelRuntime("/agent", create);
  invalidateModelsCache();
  const second = await getOrCreateModelRuntime("/agent", create);
  assert.notEqual(first, second);
  assert.equal(creates, 2);
  assert.equal(second.id, "runtime-2");
});

test("retries ModelRuntime creation after a failure", async () => {
  invalidateModelsCache();
  let attempts = 0;
  const create = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("create failed");
    return fakeRuntime("ok");
  };
  await assert.rejects(
    getOrCreateModelRuntime("/agent", create),
    /create failed/,
  );
  const fresh = await getOrCreateModelRuntime("/agent", create);
  assert.equal(fresh.id, "ok");
  assert.equal(attempts, 2);
});
