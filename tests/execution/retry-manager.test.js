import { describe, expect, it } from 'vitest';
import {
  classifyError,
  decideRetry,
  RetryManager,
} from '../../src/execution/retry-manager.js';
import { ErrorClass, TaskError } from '../../src/tasks/constants.js';
import { parseRetryAfterMs } from '../../src/execution/backoff-policy.js';

describe('retry manager', () => {
  it('classifies rate limits as retryable', () => {
    const result = classifyError(new Error('HTTP 429 Too Many Requests'));
    expect(result.errorClass).toBe(ErrorClass.RATE_LIMITED);
    expect(result.retryable).toBe(true);
  });

  it('respects Retry-After for backoff', () => {
    const decision = decideRetry({
      attemptCount: 1,
      maxAttempts: 3,
      error: new TaskError('slow down', {
        errorClass: ErrorClass.RATE_LIMITED,
        retryable: true,
        retryAfterMs: 12_000,
      }),
      baseMs: 100,
      maxMs: 60_000,
      randomFn: () => 0,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(decision.action).toBe('retry');
    expect(decision.delayMs).toBeGreaterThanOrEqual(12_000);
  });

  it('never retries verification / captcha failures', () => {
    const decision = decideRetry({
      attemptCount: 1,
      maxAttempts: 5,
      error: new TaskError('checkpoint required', {
        errorClass: ErrorClass.VERIFICATION_REQUIRED,
      }),
    });
    expect(decision.action).toBe('needs_attention');
  });

  it('sends unknown side-effect failures to NEEDS_ATTENTION', () => {
    const decision = decideRetry({
      attemptCount: 1,
      maxAttempts: 5,
      sideEffectStarted: true,
      error: new Error('something weird'),
    });
    expect(decision.action).toBe('needs_attention');
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfterMs(5)).toBe(5_000);
    expect(parseRetryAfterMs('3')).toBe(3_000);
    const future = new Date(Date.now() + 8_000).toUTCString();
    expect(parseRetryAfterMs(future)).toBeGreaterThan(1_000);
  });

  it('RetryManager.decide delegates to policy', () => {
    const manager = new RetryManager({ baseMs: 10, maxMs: 100, randomFn: () => 0 });
    const decision = manager.decide({
      attemptCount: 1,
      maxAttempts: 2,
      error: new TaskError('timeout', { errorClass: ErrorClass.TIMEOUT }),
    });
    expect(decision.action).toBe('retry');
  });
});
