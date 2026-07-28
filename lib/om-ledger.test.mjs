import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  projectObservationalMemory,
  buildActiveBranchPath,
  OM_MAX_OBSERVATIONS,
  OM_MAX_REFLECTIONS,
} = await jiti.import("./om-ledger.ts");

function obs(id, content = `obs-${id}`, relevance = "medium") {
  return {
    id,
    content,
    timestamp: "2026-01-01T00:00:00.000Z",
    relevance,
    sourceEntryIds: ["src1"],
    tokenCount: 10,
  };
}

function ref(id, content = `ref-${id}`) {
  return {
    id,
    content,
    supportingObservationIds: ["aaaaaaaaaaaa"],
    tokenCount: 5,
  };
}

function entry(id, parentId, partial) {
  return {
    id,
    parentId,
    type: "custom",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function msg(id, parentId) {
  return {
    id,
    parentId,
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: id },
  };
}

test("recorded + dropped → active 计数正确", () => {
  const entries = [
    msg("u1", null),
    entry("om1", "u1", {
      customType: "om.observations.recorded",
      data: {
        observations: [obs("aaaaaaaaaaaa"), obs("bbbbbbbbbbbb", "b", "high")],
        coversUpToId: "u1",
      },
    }),
    entry("om2", "om1", {
      customType: "om.observations.dropped",
      data: {
        observationIds: ["aaaaaaaaaaaa"],
        coversUpToId: "u1",
      },
    }),
    entry("om3", "om2", {
      customType: "om.reflections.recorded",
      data: {
        reflections: [ref("cccccccccccc")],
        coversUpToId: "u1",
      },
    }),
  ];

  const view = projectObservationalMemory(entries, "om3");
  assert.ok(view);
  assert.equal(view.hasData, true);
  assert.equal(view.counts.observationsRecorded, 2);
  assert.equal(view.counts.observationsActive, 1);
  assert.equal(view.counts.observationsDropped, 1);
  assert.equal(view.counts.reflectionsRecorded, 1);
  assert.deepEqual(view.observations.map((o) => o.id), ["bbbbbbbbbbbb"]);
  assert.deepEqual(view.reflections.map((r) => r.id), ["cccccccccccc"]);
  assert.equal(view.relevance.high, 1);
  assert.equal(view.relevance.medium, undefined);
});

test("first-valid-wins：同 id 第二次忽略", () => {
  const entries = [
    msg("u1", null),
    entry("om1", "u1", {
      customType: "om.observations.recorded",
      data: {
        observations: [obs("aaaaaaaaaaaa", "first", "low")],
        coversUpToId: "u1",
      },
    }),
    entry("om2", "om1", {
      customType: "om.observations.recorded",
      data: {
        observations: [obs("aaaaaaaaaaaa", "second", "critical")],
        coversUpToId: "u1",
      },
    }),
    entry("om3", "om2", {
      customType: "om.reflections.recorded",
      data: {
        reflections: [ref("bbbbbbbbbbbb", "r1")],
        coversUpToId: "u1",
      },
    }),
    entry("om4", "om3", {
      customType: "om.reflections.recorded",
      data: {
        reflections: [ref("bbbbbbbbbbbb", "r2")],
        coversUpToId: "u1",
      },
    }),
  ];

  const view = projectObservationalMemory(entries, "om4");
  assert.ok(view);
  assert.equal(view.observations[0].content, "first");
  assert.equal(view.observations[0].relevance, "low");
  assert.equal(view.reflections[0].content, "r1");
  assert.equal(view.counts.observationsRecorded, 1);
  assert.equal(view.counts.reflectionsRecorded, 1);
});

test("无效 data 忽略", () => {
  const entries = [
    msg("u1", null),
    entry("bad1", "u1", {
      customType: "om.observations.recorded",
      data: { observations: [], coversUpToId: "u1" },
    }),
    entry("bad2", "bad1", {
      customType: "om.observations.recorded",
      data: {
        observations: [{ id: "not-hex", content: "x", timestamp: "t", relevance: "low", sourceEntryIds: ["a"], tokenCount: 1 }],
        coversUpToId: "u1",
      },
    }),
    entry("bad3", "bad2", {
      customType: "om.reflections.recorded",
      data: {
        reflections: [{ id: "dddddddddddd", content: "has\nnewline", supportingObservationIds: ["a"], tokenCount: 1 }],
        coversUpToId: "u1",
      },
    }),
    entry("bad4", "bad3", {
      customType: "om.observations.dropped",
      data: { observationIds: [], coversUpToId: "u1" },
    }),
    entry("unk", "bad4", {
      customType: "om.unknown",
      data: { foo: 1 },
    }),
    entry("ok", "unk", {
      customType: "om.observations.recorded",
      data: {
        observations: [obs("eeeeeeeeeeee")],
        coversUpToId: "u1",
      },
    }),
  ];

  const view = projectObservationalMemory(entries, "ok");
  assert.ok(view);
  assert.equal(view.counts.observationsRecorded, 1);
  assert.equal(view.counts.observationsDropped, 0);
  assert.equal(view.counts.reflectionsRecorded, 0);
  assert.deepEqual(view.observations.map((o) => o.id), ["eeeeeeeeeeee"]);
});

test("无 om → null", () => {
  const entries = [
    msg("u1", null),
    msg("a1", "u1"),
    entry("custom1", "a1", {
      customType: "something.else",
      data: { x: 1 },
    }),
  ];
  assert.equal(projectObservationalMemory(entries, "custom1"), null);
  assert.equal(projectObservationalMemory([], null), null);
});

test("列表有界截断：保留较新（slice 末尾）", () => {
  const manyObs = Array.from({ length: OM_MAX_OBSERVATIONS + 5 }, (_, i) => {
    const id = i.toString(16).padStart(12, "0");
    return obs(id, `o${i}`, i % 2 === 0 ? "low" : "high");
  });
  const manyRefs = Array.from({ length: OM_MAX_REFLECTIONS + 3 }, (_, i) => {
    const id = (i + 1000).toString(16).padStart(12, "0");
    return ref(id, `r${i}`);
  });

  const entries = [
    msg("u1", null),
    entry("om1", "u1", {
      customType: "om.observations.recorded",
      data: { observations: manyObs, coversUpToId: "u1" },
    }),
    entry("om2", "om1", {
      customType: "om.reflections.recorded",
      data: { reflections: manyRefs, coversUpToId: "u1" },
    }),
  ];

  const view = projectObservationalMemory(entries, "om2");
  assert.ok(view);
  assert.equal(view.counts.observationsActive, OM_MAX_OBSERVATIONS + 5);
  assert.equal(view.counts.reflectionsRecorded, OM_MAX_REFLECTIONS + 3);
  assert.equal(view.observations.length, OM_MAX_OBSERVATIONS);
  assert.equal(view.reflections.length, OM_MAX_REFLECTIONS);
  // 末尾优先：最后一条应是索引 max+4 / max+2
  assert.equal(view.observations[view.observations.length - 1].content, `o${OM_MAX_OBSERVATIONS + 4}`);
  assert.equal(view.observations[0].content, `o${5}`);
  assert.equal(view.reflections[view.reflections.length - 1].content, `r${OM_MAX_REFLECTIONS + 2}`);
  assert.equal(view.reflections[0].content, `r${3}`);
});

test("分支路径：兄弟分支上的 om 不进入当前 leaf 投影", () => {
  // u1 → a1 → omA（仅 A 分支）
  // u1 → b1 → omB（仅 B 分支）
  const entries = [
    msg("u1", null),
    msg("a1", "u1"),
    entry("omA", "a1", {
      customType: "om.observations.recorded",
      data: {
        observations: [obs("aaaaaaaaaaaa", "on-branch-A")],
        coversUpToId: "a1",
      },
    }),
    msg("b1", "u1"),
    entry("omB", "b1", {
      customType: "om.observations.recorded",
      data: {
        observations: [obs("bbbbbbbbbbbb", "on-branch-B", "critical")],
        coversUpToId: "b1",
      },
    }),
  ];

  const viewA = projectObservationalMemory(entries, "omA");
  assert.ok(viewA);
  assert.deepEqual(viewA.observations.map((o) => o.id), ["aaaaaaaaaaaa"]);
  assert.equal(viewA.counts.observationsRecorded, 1);

  const viewB = projectObservationalMemory(entries, "omB");
  assert.ok(viewB);
  assert.deepEqual(viewB.observations.map((o) => o.id), ["bbbbbbbbbbbb"]);
  assert.equal(viewB.relevance.critical, 1);

  // leaf 在 a1 时，omA 不在 path（omA 是 a1 的子节点）
  const viewA1 = projectObservationalMemory(entries, "a1");
  assert.equal(viewA1, null);

  // 全量顺序（leaf 找不到）会扫到两条 — 仅验证 path 构造
  const fullPath = buildActiveBranchPath(entries, "missing");
  assert.equal(fullPath.length, entries.length);
  const pathB = buildActiveBranchPath(entries, "omB");
  assert.deepEqual(pathB.map((e) => e.id), ["u1", "b1", "omB"]);
});
