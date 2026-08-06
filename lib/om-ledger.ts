/**
 * Observational Memory (om) 只读 ledger 投影。
 * 从会话 custom entries 折叠 observations/reflections，不写 om/Pi schema，
 * 也不把 ledger 条目伪装成聊天气泡。
 */

import { buildActiveBranchPath, type SessionBranchEntry } from "./session-branch-path";

export { buildActiveBranchPath };
/** 兼容导出：投影公共 entry 结构（与 session-branch-path 的 SessionBranchEntry 同构） */
export type OmLedgerEntry = SessionBranchEntry;

export type OmRelevance = "low" | "medium" | "high" | "critical";

export interface OmObservationView {
  id: string;
  content: string;
  timestamp: string;
  relevance: OmRelevance;
  tokenCount: number;
}

export interface OmReflectionView {
  id: string;
  content: string;
  tokenCount: number;
}

export interface ObservationalMemoryView {
  hasData: true;
  counts: {
    observationsRecorded: number;
    observationsActive: number;
    observationsDropped: number;
    reflectionsRecorded: number;
  };
  relevance: Partial<Record<OmRelevance, number>>;
  observations: OmObservationView[];
  reflections: OmReflectionView[];
}

/** 有界列表：active observations 最多 40，reflections 最多 20 */
export const OM_MAX_OBSERVATIONS = 40;
export const OM_MAX_REFLECTIONS = 20;

const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";

const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;
const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

type Observation = {
  id: string;
  content: string;
  timestamp: string;
  relevance: OmRelevance;
  sourceEntryIds: string[];
  tokenCount: number;
};

type Reflection = {
  id: string;
  content: string;
  supportingObservationIds: string[];
  tokenCount: number;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isMemoryId(value: unknown): value is string {
  return typeof value === "string" && MEMORY_ID_PATTERN.test(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRelevance(value: unknown): value is OmRelevance {
  return typeof value === "string" && (RELEVANCE_VALUES as readonly string[]).includes(value);
}

function isObservation(value: unknown): value is Observation {
  if (!isPlainRecord(value)) return false;
  return (
    isMemoryId(value.id) &&
    isNonEmptyString(value.content) &&
    isNonEmptyString(value.timestamp) &&
    isRelevance(value.relevance) &&
    isNonEmptyStringArray(value.sourceEntryIds) &&
    isTokenCount(value.tokenCount)
  );
}

function isReflection(value: unknown): value is Reflection {
  if (!isPlainRecord(value)) return false;
  return (
    isMemoryId(value.id) &&
    isNonEmptyString(value.content) &&
    !/\r|\n/.test(value.content) &&
    isNonEmptyStringArray(value.supportingObservationIds) &&
    isTokenCount(value.tokenCount)
  );
}

function isObservationsRecordedData(value: unknown): value is { observations: Observation[]; coversUpToId: string } {
  if (!isPlainRecord(value)) return false;
  return (
    Array.isArray(value.observations) &&
    value.observations.length > 0 &&
    value.observations.every(isObservation) &&
    isNonEmptyString(value.coversUpToId)
  );
}

function isReflectionsRecordedData(value: unknown): value is { reflections: Reflection[]; coversUpToId: string } {
  if (!isPlainRecord(value)) return false;
  return (
    Array.isArray(value.reflections) &&
    value.reflections.length > 0 &&
    value.reflections.every(isReflection) &&
    isNonEmptyString(value.coversUpToId)
  );
}

function isObservationsDroppedData(value: unknown): value is { observationIds: string[]; coversUpToId: string } {
  if (!isPlainRecord(value)) return false;
  return isNonEmptyStringArray(value.observationIds) && isNonEmptyString(value.coversUpToId);
}

function takeTail<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  return items.slice(items.length - max);
}

/**
 * 在 active branch path 上 fold om custom entries，投影为只读视图。
 * first-valid-wins；drop 为 tombstone；无效/未知 custom 忽略。
 * 无任何有效 om entry 时返回 null。
 */
export function projectObservationalMemory(
  entries: ReadonlyArray<OmLedgerEntry>,
  leafId?: string | null,
): ObservationalMemoryView | null {
  const path = buildActiveBranchPath(entries, leafId);

  const observationsById = new Map<string, Observation>();
  const reflectionsById = new Map<string, Reflection>();
  const droppedObservationIds = new Set<string>();
  let sawValidOm = false;

  for (const entry of path) {
    if (entry.type !== "custom") continue;
    const customType = entry.customType;
    const data = entry.data;

    if (customType === OM_OBSERVATIONS_RECORDED) {
      if (!isObservationsRecordedData(data)) continue;
      sawValidOm = true;
      for (const observation of data.observations) {
        if (!observationsById.has(observation.id)) {
          observationsById.set(observation.id, observation);
        }
      }
      continue;
    }

    if (customType === OM_REFLECTIONS_RECORDED) {
      if (!isReflectionsRecordedData(data)) continue;
      sawValidOm = true;
      for (const reflection of data.reflections) {
        if (!reflectionsById.has(reflection.id)) {
          reflectionsById.set(reflection.id, reflection);
        }
      }
      continue;
    }

    if (customType === OM_OBSERVATIONS_DROPPED) {
      if (!isObservationsDroppedData(data)) continue;
      sawValidOm = true;
      for (const observationId of data.observationIds) {
        droppedObservationIds.add(observationId);
      }
    }
  }

  if (!sawValidOm) return null;

  const observations = Array.from(observationsById.values());
  const activeObservations = observations.filter((o) => !droppedObservationIds.has(o.id));
  const reflections = Array.from(reflectionsById.values());

  const relevance: Partial<Record<OmRelevance, number>> = {};
  for (const o of activeObservations) {
    relevance[o.relevance] = (relevance[o.relevance] ?? 0) + 1;
  }

  const observationViews: OmObservationView[] = takeTail(activeObservations, OM_MAX_OBSERVATIONS).map((o) => ({
    id: o.id,
    content: o.content,
    timestamp: o.timestamp,
    relevance: o.relevance,
    tokenCount: o.tokenCount,
  }));

  const reflectionViews: OmReflectionView[] = takeTail(reflections, OM_MAX_REFLECTIONS).map((r) => ({
    id: r.id,
    content: r.content,
    tokenCount: r.tokenCount,
  }));

  return {
    hasData: true,
    counts: {
      observationsRecorded: observations.length,
      observationsActive: activeObservations.length,
      observationsDropped: droppedObservationIds.size,
      reflectionsRecorded: reflections.length,
    },
    relevance,
    observations: observationViews,
    reflections: reflectionViews,
  };
}
