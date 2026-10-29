/**
 * Error classification + exponential backoff helper for LLM provider calls.
 *
 * Distinguishes between errors the agent loop should retry on (transient
 * network blips, 429/529 overloads, timeouts), errors that should trigger a
 * credential fallback (401/403), and errors that should abort immediately
 * (invalid request, context overflow).
 */

export type ErrorClass =
  | "overloaded"        // 429 / 529 ,  retry with backoff
  | "rate-limited"      // OpenAI-style 429 ,  retry with backoff
  | "transient"         // 502 / 503 / network blip ,  retry small N
  | "timeout"           // AbortSignal timeout , retry small N
  | "auth"              // 401 / 403 ,  non-retryable; resolver layer escalates to fallback
  | "context-overflow"  // model token cap ,  non-retryable, escalate to caller
  | "invalid-request"   // 400 ,  non-retryable, log and raise
  | "unknown";

export class HttpError extends Error {
  /**
   * Parsed retry-after delay in milliseconds, if the server sent one. We
   * honour this in `withRetry` so 429s sleep for the duration the provider
   * actually asked for instead of our small exponential backoff. Anthropic
   * commonly returns 8s–60s here during peak-hour Pro/Max plan throttling.
   */
  public readonly retryAfterMs: number | null;

  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    options?: { headers?: Headers; message?: string },
  ) {
    super(options?.message ?? `HTTP ${status}: ${bodyText.slice(0, 200)}`);
    this.name = "HttpError";
    this.retryAfterMs = parseRetryAfter(options?.headers);
  }
}

/**
 * Parse RFC 7231 `Retry-After` header. Spec allows either a delta-seconds
 * integer (e.g. "30") or an HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT").
 * Returns null when the header is missing or unparseable; clamped to a
 * sensible 60s ceiling so a misbehaving provider can't stall the user for
 * minutes.
 */
function parseRetryAfter(headers?: Headers): number | null {
  if (!headers) return null;
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const trimmed = raw.trim();
  // delta-seconds (most common case for Anthropic / OpenAI)
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return Math.min(seconds, 60) * 1000;
  }
  // HTTP-date
  const ts = Date.parse(trimmed);
  if (Number.isNaN(ts)) return null;
  const delta = ts - Date.now();
  if (delta <= 0) return 0;
  return Math.min(delta, 60_000);
}

export function classifyError(err: unknown): ErrorClass {
  if (err instanceof HttpError) {
    if (err.status === 429) return "rate-limited";
    if (err.status === 529) return "overloaded";
    if (err.status === 401 || err.status === 403) return "auth";
    if (err.status === 400) {
      // Heuristic: Anthropic returns 400 for context overflow with a "context"
      // mention in the body; OpenAI returns "context_length_exceeded".
      if (/context|max.?tokens|too.?long|prompt.*length/i.test(err.bodyText)) {
        return "context-overflow";
      }
      return "invalid-request";
    }
    if (err.status >= 500 && err.status < 600) return "transient";
    return "unknown";
  }
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "TimeoutError") return "timeout";
  if (err instanceof Error && /aborted|aborterror|timeout|timed out|ETIMEDOUT/i.test(err.message)) {
    return "timeout";
  }
  // Network errors from fetch surface as TypeErrors with various messages
  if (err instanceof TypeError && /fetch|network|ECONNRESET|ETIMEDOUT/i.test(err.message)) {
    return "transient";
  }
  return "unknown";
}

export function isRetryable(cls: ErrorClass): boolean {
  return cls === "overloaded" || cls === "rate-limited" || cls === "transient" || cls === "timeout";
}

/** Sleep with optional AbortSignal support. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Aborted"));
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("Aborted"));
      }, { once: true });
    }
  });
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxAttempts?: number; baseDelayMs?: number; signal?: AbortSignal },
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const cls = classifyError(err);
      if (!isRetryable(cls) || attempt === maxAttempts) throw err;
      // Honour the provider's Retry-After if they sent one; otherwise fall
      // back to exponential backoff. Take whichever is *longer* — the
      // provider's hint is usually the tighter constraint, but our floor
      // prevents a cooperative provider from pinning us to 0s.
      const exp = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 250;
      const hinted = err instanceof HttpError ? err.retryAfterMs : null;
      const delay = hinted !== null ? Math.max(hinted, exp) : exp;
      await sleep(Math.min(delay, 10_000), opts?.signal);
    }
  }
  throw lastErr;
}
