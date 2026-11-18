export const CONTROL_METHODS = Object.freeze({
  STATUS: 'status',
  PAUSE: 'pause',
  RESUME: 'resume',
  JOBS: 'jobs',
  DOCTOR: 'doctor',
  PING: 'ping',
});

/**
 * @param {unknown} message
 * @returns {{ id: string, method: string, params?: Record<string, unknown> }}
 */
export function parseRequest(message) {
  if (!message || typeof message !== 'object') {
    throw new Error('Invalid control request');
  }
  const id = 'id' in message ? String(message.id) : '';
  const method = 'method' in message ? String(message.method) : '';
  if (!id || !method) {
    throw new Error('Control request requires id and method');
  }
  return {
    id,
    method,
    params:
      'params' in message && message.params && typeof message.params === 'object'
        ? /** @type {Record<string, unknown>} */ (message.params)
        : {},
  };
}

/**
 * @param {string} id
 * @param {unknown} result
 */
export function successResponse(id, result) {
  return { id, ok: true, result };
}

/**
 * @param {string} id
 * @param {string} error
 * @param {string} [code]
 */
export function errorResponse(id, error, code = 'CONTROL_ERROR') {
  return { id, ok: false, error: { message: error, code } };
}
