/**
 * Helpers for stable idempotency keys.
 */
export class IdempotencyManager {
  /**
   * @param {string | null | undefined} key
   * @returns {string | null}
   */
  normalize(key) {
    if (key == null) {
      return null;
    }
    const trimmed = String(key).trim();
    return trimmed === '' ? null : trimmed;
  }

  /**
   * Build a schedule-slot idempotency key to prevent duplicate enqueue.
   *
   * @param {string} prefix
   * @param {string} slotIso
   * @returns {string}
   */
  forScheduleSlot(prefix, slotIso) {
    return `${prefix}:${slotIso}`;
  }
}
