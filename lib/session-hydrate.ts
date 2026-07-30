/**
 * 按真实 session id 有界精确补水（纯函数 + 注入 fetch/delay）。
 * 覆盖「Pi 已返回 id 但列表投影尚未可见」的短窗口；不无限 polling。
 */

export type SessionHydrateFetch = (
  sessionId: string,
  signal: AbortSignal,
) => Promise<Response>;

export type SessionHydrateDelay = (ms: number, signal: AbortSignal) => Promise<void>;

export type SessionHydrateOptions<T> = {
  sessionId: string;
  /** 当前仍有效时返回 true；false 则停止（intent 切换 / 卸载 / 选中其它会话）。 */
  isCurrent: () => boolean;
  fetchSession: SessionHydrateFetch;
  parseBody: (body: unknown) => T | null;
  signal?: AbortSignal;
  /** 最大尝试次数（含首次），默认 5。 */
  maxAttempts?: number;
  /** 退避基数 ms，第 n 次失败后等待 base * 2^(n-1)，默认 200。 */
  baseDelayMs?: number;
  delay?: SessionHydrateDelay;
};

export type SessionHydrateResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; reason: "not_found" | "error" | "aborted" | "stale" | "exhausted"; attempts: number; status?: number; error?: string };

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 200;

export function defaultHydrateDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 有界重试：
 * - 200 + 可解析 body → 成功
 * - 404 → 可重试（至上限）
 * - 其它 4xx / 5xx / 网络错误 → 立即结束（error）
 * - abort / isCurrent false → aborted / stale
 */
export async function hydrateSessionById<T>(
  options: SessionHydrateOptions<T>,
): Promise<SessionHydrateResult<T>> {
  const {
    sessionId,
    isCurrent,
    fetchSession,
    parseBody,
    signal,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    delay = defaultHydrateDelay,
  } = options;

  const attemptsLimit = Math.max(1, Math.floor(maxAttempts));
  let attempts = 0;

  while (attempts < attemptsLimit) {
    attempts += 1;
    if (signal?.aborted) {
      return { ok: false, reason: "aborted", attempts };
    }
    if (!isCurrent()) {
      return { ok: false, reason: "stale", attempts };
    }

    try {
      const res = await fetchSession(sessionId, signal ?? new AbortController().signal);
      if (signal?.aborted || !isCurrent()) {
        return { ok: false, reason: signal?.aborted ? "aborted" : "stale", attempts };
      }

      if (res.status === 404) {
        if (attempts >= attemptsLimit) {
          return { ok: false, reason: "not_found", attempts, status: 404 };
        }
        const wait = baseDelayMs * 2 ** (attempts - 1);
        try {
          await delay(wait, signal ?? new AbortController().signal);
        } catch {
          return { ok: false, reason: "aborted", attempts };
        }
        continue;
      }

      if (!res.ok) {
        return {
          ok: false,
          reason: "error",
          attempts,
          status: res.status,
          error: `HTTP ${res.status}`,
        };
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch (e) {
        return {
          ok: false,
          reason: "error",
          attempts,
          status: res.status,
          error: e instanceof Error ? e.message : String(e),
        };
      }

      if (!isCurrent() || signal?.aborted) {
        return { ok: false, reason: signal?.aborted ? "aborted" : "stale", attempts };
      }

      const value = parseBody(body);
      if (value == null) {
        return {
          ok: false,
          reason: "error",
          attempts,
          status: res.status,
          error: "empty body",
        };
      }
      return { ok: true, value, attempts };
    } catch (e) {
      if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) {
        return { ok: false, reason: "aborted", attempts };
      }
      return {
        ok: false,
        reason: "error",
        attempts,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  return { ok: false, reason: "exhausted", attempts };
}
