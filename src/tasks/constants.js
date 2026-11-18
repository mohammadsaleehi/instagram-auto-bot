/**
 * Task statuses and shared task-engine constants.
 */

export const TaskStatus = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  NEEDS_ATTENTION: 'NEEDS_ATTENTION',
});

export const TASK_STATUSES = Object.freeze(Object.values(TaskStatus));

export const ErrorClass = Object.freeze({
  TRANSIENT_NETWORK: 'TRANSIENT_NETWORK',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  VERIFICATION_REQUIRED: 'VERIFICATION_REQUIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  INVALID_INPUT: 'INVALID_INPUT',
  UNKNOWN: 'UNKNOWN',
  SHUTDOWN: 'SHUTDOWN',
  CANCELLED: 'CANCELLED',
});

export const ERROR_CLASSES = Object.freeze(Object.values(ErrorClass));

/** Error classes that may be retried with backoff. */
export const RETRYABLE_ERROR_CLASSES = Object.freeze(
  new Set([
    ErrorClass.TRANSIENT_NETWORK,
    ErrorClass.TIMEOUT,
    ErrorClass.RATE_LIMITED,
  ]),
);

/** Error classes that must never be auto-retried. */
export const NON_RETRYABLE_ERROR_CLASSES = Object.freeze(
  new Set([
    ErrorClass.AUTHENTICATION_REQUIRED,
    ErrorClass.VERIFICATION_REQUIRED,
    ErrorClass.PERMISSION_DENIED,
    ErrorClass.INVALID_INPUT,
    ErrorClass.SHUTDOWN,
    ErrorClass.CANCELLED,
  ]),
);

export const TaskEventType = Object.freeze({
  CREATED: 'CREATED',
  CLAIMED: 'CLAIMED',
  STARTED: 'STARTED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  RETRY_SCHEDULED: 'RETRY_SCHEDULED',
  CANCELLED: 'CANCELLED',
  NEEDS_ATTENTION: 'NEEDS_ATTENTION',
  RECOVERED: 'RECOVERED',
  PAUSED: 'PAUSED',
  RESUMED: 'RESUMED',
});

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_PRIORITY = 100;
export const DEMO_TASK_TYPE = 'engine.health-check';

export class TaskError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   code?: string,
   *   errorClass?: string,
   *   retryable?: boolean,
   *   retryAfterMs?: number | null,
   *   cause?: unknown,
   *   details?: Record<string, unknown>,
   * }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'TaskError';
    this.code = options.code ?? 'TASK_ERROR';
    this.errorClass = options.errorClass ?? ErrorClass.UNKNOWN;
    this.retryable =
      options.retryable ?? RETRYABLE_ERROR_CLASSES.has(this.errorClass);
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.details = options.details ?? undefined;
  }
}
