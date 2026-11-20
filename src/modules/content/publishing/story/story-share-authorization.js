/**
 * One-time Share authorization.
 *
 * This is an in-memory grant from the supervisor for exactly one operation and
 * exactly one media checksum. The durable one-time enforcement lives in
 * `StoryOperationStore.recordShareIntent()` (`share_intent_at`), which is
 * written immediately before the single click.
 */
export const SHARE_AUTHORIZATION_SCOPE = 'single-story-publication';

/**
 * @param {{
 *   scope?: string,
 *   operationId?: string,
 *   contentId?: string,
 *   mediaChecksumSha256?: string,
 *   maxShares?: number,
 *   authorizedAt?: string,
 *   notAfter?: string,
 * }|null|undefined} authorization
 * @param {{
 *   operationId: string,
 *   contentId: string,
 *   mediaChecksumSha256: string,
 *   now?: Date,
 * }} input
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateShareAuthorization(authorization, input) {
  if (!authorization || typeof authorization !== 'object') {
    return { ok: false, reason: 'missing-authorization' };
  }
  if (authorization.scope !== SHARE_AUTHORIZATION_SCOPE) {
    return { ok: false, reason: 'invalid-scope' };
  }
  if (authorization.operationId !== input.operationId) {
    return { ok: false, reason: 'operation-mismatch' };
  }
  if (authorization.contentId !== input.contentId) {
    return { ok: false, reason: 'content-mismatch' };
  }
  if (authorization.mediaChecksumSha256 !== input.mediaChecksumSha256) {
    return { ok: false, reason: 'media-checksum-mismatch' };
  }
  if (authorization.maxShares !== 1) {
    return { ok: false, reason: 'max-shares-must-be-one' };
  }
  if (authorization.notAfter) {
    const notAfter = Date.parse(authorization.notAfter);
    const now = (input.now ?? new Date()).getTime();
    if (!Number.isFinite(notAfter) || now > notAfter) {
      return { ok: false, reason: 'authorization-expired' };
    }
  }
  return { ok: true };
}

/**
 * Build the supervisor grant for one operation. The caller still must pass it
 * to an adapter that has `enablePublication: true`.
 *
 * @param {{
 *   operationId: string,
 *   contentId: string,
 *   mediaChecksumSha256: string,
 *   ttlMs?: number,
 *   nowFn?: () => Date,
 * }} input
 * @returns {Record<string, unknown>}
 */
export function createShareAuthorization(input) {
  const now = (input.nowFn ?? (() => new Date()))();
  const ttlMs = input.ttlMs ?? 15 * 60 * 1000;
  return {
    scope: SHARE_AUTHORIZATION_SCOPE,
    operationId: input.operationId,
    contentId: input.contentId,
    mediaChecksumSha256: input.mediaChecksumSha256,
    maxShares: 1,
    authorizedAt: now.toISOString(),
    notAfter: new Date(now.getTime() + ttlMs).toISOString(),
  };
}
