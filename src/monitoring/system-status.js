/**
 * Build the operator-facing status payload for `npm run status`.
 *
 * @param {{
 *   applicationState: string,
 *   health: ReturnType<import('./health-monitor.js').HealthMonitor['snapshot']>,
 *   startedAt?: string | null,
 * }} input
 */
export function buildSystemStatus(input) {
  const health = input.health;
  return {
    applicationState: input.applicationState,
    startedAt: input.startedAt ?? null,
    browser: {
      connected: health.browser.connected,
      mode: health.browser.mode,
    },
    authentication: {
      state: health.session?.lastState ?? null,
      invalid: Boolean(health.session?.invalid),
      lastCheckedAt: health.session?.lastCheckedAt ?? null,
      recovery: health.session?.recovery ?? null,
    },
    worker: health.worker,
    queueSize: health.worker?.queueSize ?? 0,
    runningTask: health.worker?.currentTask ?? null,
    failedTaskCount: health.worker?.counts?.FAILED ?? 0,
    needsAttentionCount: health.worker?.counts?.NEEDS_ATTENTION ?? 0,
    lastSuccessfulTask: health.worker?.lastSuccessful ?? null,
    lastSessionPersistence: health.persistence?.lastSaveAt ?? null,
    database: {
      open: health.database.open,
      integrityOk: health.database.integrity?.ok ?? false,
    },
    lastError: health.lastError,
  };
}
