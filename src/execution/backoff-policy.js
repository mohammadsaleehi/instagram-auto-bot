/**
 * Exponential backoff with full jitter.
 *
 * delay = random(0, min(maxMs, baseMs * 2^attempt))
 * If retryAfterMs is provided, it is respected as a lower bound.
 */

/**
 * @param {{
 *   attempt: number,
 *   baseMs?: number,
 *   maxMs?: number,
 *   retryAfterMs?: number | null,
 *   randomFn?: () => number,
 * }} options
 * @returns {number}
 */
export function computeBackoffDelayMs(options) {
  const attempt = Math.max(0, options.attempt);
  const baseMs = options.baseMs ?? 5_000;
  const maxMs = options.maxMs ?? 300_000;
  const randomFn = options.randomFn ?? Math.random;

  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  const jittered = Math.floor(randomFn() * (exp + 1));
  const retryAfter = options.retryAfterMs ?? null;

  if (retryAfter != null && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(maxMs, Math.max(jittered, Math.floor(retryAfter)));
  }

  return Math.min(maxMs, jittered);
}

/**
 * Parse Retry-After style values (seconds or HTTP-date-like delay already in ms).
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseRetryAfterMs(value) {
  if (value == null) {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    // Treat small numbers as seconds, large as milliseconds.
    return value < 1_000_000 ? Math.floor(value * 1000) : Math.floor(value);
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber >= 0) {
      return asNumber < 1_000_000
        ? Math.floor(asNumber * 1000)
        : Math.floor(asNumber);
    }

    const asDate = Date.parse(value);
    if (!Number.isNaN(asDate)) {
      const delta = asDate - Date.now();
      return delta > 0 ? delta : 0;
    }
  }

  return null;
}
