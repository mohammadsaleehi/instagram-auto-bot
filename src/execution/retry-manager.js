import {
  ErrorClass,
  NON_RETRYABLE_ERROR_CLASSES,
  RETRYABLE_ERROR_CLASSES,
  TaskError,
} from '../tasks/constants.js';
import { computeBackoffDelayMs, parseRetryAfterMs } from './backoff-policy.js';

/**
 * Classify an unknown failure into a stable error class.
 *
 * @param {unknown} error
 * @returns {{
 *   errorClass: string,
 *   retryable: boolean,
 *   retryAfterMs: number | null,
 *   message: string,
 *   code: string | null,
 * }}
 */
export function classifyError(error) {
  if (error instanceof TaskError) {
    return {
      errorClass: error.errorClass,
      retryable: Boolean(error.retryable),
      retryAfterMs: error.retryAfterMs,
      message: error.message,
      code: error.code,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(/** @type {{ code?: unknown }} */ (error).code ?? '')
      : '';

  const retryAfterMs = parseRetryAfterMs(
    error && typeof error === 'object' && 'retryAfterMs' in error
      ? /** @type {{ retryAfterMs?: unknown }} */ (error).retryAfterMs
      : null,
  );

  const lowered = `${name} ${message} ${code}`.toLowerCase();

  if (
    lowered.includes('authentication') ||
    lowered.includes('login_required') ||
    lowered.includes('not authenticated')
  ) {
    return {
      errorClass: ErrorClass.AUTHENTICATION_REQUIRED,
      retryable: false,
      retryAfterMs: null,
      message,
      code: code || null,
    };
  }

  if (
    lowered.includes('verification') ||
    lowered.includes('checkpoint') ||
    lowered.includes('captcha') ||
    lowered.includes('2fa') ||
    lowered.includes('challenge')
  ) {
    return {
      errorClass: ErrorClass.VERIFICATION_REQUIRED,
      retryable: false,
      retryAfterMs: null,
      message,
      code: code || null,
    };
  }

  if (
    lowered.includes('rate limit') ||
    lowered.includes('too many requests') ||
    code === 'RATE_LIMITED' ||
    lowered.includes('429')
  ) {
    return {
      errorClass: ErrorClass.RATE_LIMITED,
      retryable: true,
      retryAfterMs,
      message,
      code: code || null,
    };
  }

  if (
    lowered.includes('timeout') ||
    lowered.includes('timed out') ||
    code === 'ETIMEDOUT' ||
    name === 'TimeoutError'
  ) {
    return {
      errorClass: ErrorClass.TIMEOUT,
      retryable: true,
      retryAfterMs,
      message,
      code: code || null,
    };
  }

  if (
    lowered.includes('econnreset') ||
    lowered.includes('econnrefused') ||
    lowered.includes('network') ||
    lowered.includes('socket') ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND'
  ) {
    return {
      errorClass: ErrorClass.TRANSIENT_NETWORK,
      retryable: true,
      retryAfterMs,
      message,
      code: code || null,
    };
  }

  if (
    lowered.includes('permission') ||
    lowered.includes('forbidden') ||
    lowered.includes('403')
  ) {
    return {
      errorClass: ErrorClass.PERMISSION_DENIED,
      retryable: false,
      retryAfterMs: null,
      message,
      code: code || null,
    };
  }

  if (
    lowered.includes('invalid') ||
    lowered.includes('validation') ||
    lowered.includes('bad request')
  ) {
    return {
      errorClass: ErrorClass.INVALID_INPUT,
      retryable: false,
      retryAfterMs: null,
      message,
      code: code || null,
    };
  }

  if (
    lowered.includes('shutdown') ||
    lowered.includes('aborted') ||
    name === 'ShutdownError' ||
    name === 'AbortError'
  ) {
    return {
      errorClass: ErrorClass.SHUTDOWN,
      retryable: false,
      retryAfterMs: null,
      message,
      code: code || null,
    };
  }

  return {
    errorClass: ErrorClass.UNKNOWN,
    retryable: false,
    retryAfterMs,
    message,
    code: code || null,
  };
}

/**
 * Decide the next action after a task failure.
 *
 * @param {{
 *   attemptCount: number,
 *   maxAttempts: number,
 *   error: unknown,
 *   sideEffectStarted?: boolean,
 *   baseMs?: number,
 *   maxMs?: number,
 *   now?: Date,
 *   randomFn?: () => number,
 * }} input
 */
export function decideRetry(input) {
  const classified = classifyError(input.error);
  const sanitizedError = {
    message: classified.message,
    errorClass: classified.errorClass,
    code: classified.code,
    retryable: classified.retryable,
  };

  if (input.sideEffectStarted && classified.errorClass === ErrorClass.UNKNOWN) {
    return {
      action: 'needs_attention',
      reason: 'Unknown outcome after external side effect may have started',
      error: sanitizedError,
      nextAttemptAt: null,
      delayMs: null,
    };
  }

  if (
    NON_RETRYABLE_ERROR_CLASSES.has(classified.errorClass) ||
    classified.errorClass === ErrorClass.VERIFICATION_REQUIRED ||
    classified.errorClass === ErrorClass.AUTHENTICATION_REQUIRED
  ) {
    return {
      action:
        classified.errorClass === ErrorClass.SHUTDOWN ||
        classified.errorClass === ErrorClass.CANCELLED
          ? 'cancel'
          : classified.errorClass === ErrorClass.AUTHENTICATION_REQUIRED ||
              classified.errorClass === ErrorClass.VERIFICATION_REQUIRED
            ? 'needs_attention'
            : 'fail',
      reason: classified.errorClass,
      error: sanitizedError,
      nextAttemptAt: null,
      delayMs: null,
    };
  }

  const attemptsRemaining = input.attemptCount < input.maxAttempts;
  const retryable =
    classified.retryable && RETRYABLE_ERROR_CLASSES.has(classified.errorClass);

  if (!retryable || !attemptsRemaining) {
    return {
      action: input.sideEffectStarted ? 'needs_attention' : 'fail',
      reason: !retryable ? 'non_retryable' : 'max_attempts_exceeded',
      error: sanitizedError,
      nextAttemptAt: null,
      delayMs: null,
    };
  }

  const delayMs = computeBackoffDelayMs({
    attempt: Math.max(0, input.attemptCount - 1),
    baseMs: input.baseMs,
    maxMs: input.maxMs,
    retryAfterMs: classified.retryAfterMs,
    randomFn: input.randomFn,
  });
  const now = input.now ?? new Date();
  const nextAttemptAt = new Date(now.getTime() + delayMs).toISOString();

  return {
    action: 'retry',
    reason: classified.errorClass,
    error: sanitizedError,
    nextAttemptAt,
    delayMs,
  };
}

export class RetryManager {
  /**
   * @param {{
   *   baseMs?: number,
   *   maxMs?: number,
   *   randomFn?: () => number,
   * }} [options]
   */
  constructor(options = {}) {
    this.baseMs = options.baseMs ?? 5_000;
    this.maxMs = options.maxMs ?? 300_000;
    this.randomFn = options.randomFn ?? Math.random;
  }

  /**
   * @param {Parameters<typeof decideRetry>[0]} input
   */
  decide(input) {
    return decideRetry({
      ...input,
      baseMs: input.baseMs ?? this.baseMs,
      maxMs: input.maxMs ?? this.maxMs,
      randomFn: input.randomFn ?? this.randomFn,
    });
  }
}
