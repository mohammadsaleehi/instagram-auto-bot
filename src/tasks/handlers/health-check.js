import { DEMO_TASK_TYPE } from '../constants.js';

/**
 * Harmless internal demo task used to verify the automation engine.
 * Does not touch Instagram or perform external side effects.
 */
export const healthCheckHandler = Object.freeze({
  type: DEMO_TASK_TYPE,
  description: 'Internal engine health check (no Instagram side effects)',
  requiresAuth: false,
  externalSideEffect: false,
  /**
   * @param {import('../types.js').TaskExecutionContext} context
   * @param {Record<string, unknown>} payload
   * @param {AbortSignal} signal
   */
  async execute(context, payload, signal) {
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Health check aborted');
    }

    const started = Date.now();
    const note =
      typeof payload?.note === 'string' ? payload.note : 'engine-ok';

    context.logger.debug('Running engine health-check task', { note });

    return {
      ok: true,
      note,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      worker: true,
    };
  },
});
