/**
 * Aggregates browser, session, worker and database health.
 */
export class HealthMonitor {
  /**
   * @param {{
   *   browser?: import('../adapters/browser-adapter.js').BrowserAdapter | null,
   *   session?: import('./session-monitor.js').SessionMonitor | null,
   *   database?: import('../storage/database.js').Database | null,
   *   taskManager?: import('../tasks/task-manager.js').TaskManager | null,
   *   persistence?: { isRunning?: () => boolean, lastSaveAt?: string | null } | null,
   * }} [options]
   */
  constructor(options = {}) {
    this.browser = options.browser ?? null;
    this.session = options.session ?? null;
    this.database = options.database ?? null;
    this.taskManager = options.taskManager ?? null;
    this.persistence = options.persistence ?? null;
    /** @type {string | null} */
    this.lastError = null;
  }

  /**
   * @param {string | null} message
   */
  setLastError(message) {
    this.lastError = message;
  }

  /**
   * @returns {object}
   */
  snapshot() {
    const dbIntegrity = this.database?.isOpen()
      ? this.database.checkIntegrity()
      : { ok: false, detail: 'closed' };
    const taskStatus = this.taskManager?.getStatus() ?? null;
    const browserHealth = this.browser?.getHealth() ?? {
      connected: false,
      mode: null,
      ownsProcess: false,
    };
    const sessionStatus = this.session?.getStatus() ?? null;

    return {
      healthy:
        Boolean(browserHealth.connected) &&
        dbIntegrity.ok &&
        !sessionStatus?.invalid,
      browser: browserHealth,
      session: sessionStatus,
      database: {
        open: Boolean(this.database?.isOpen()),
        integrity: dbIntegrity,
        path: this.database?.filePath ?? null,
      },
      worker: taskStatus
        ? {
            running: taskStatus.workerRunning,
            paused: taskStatus.workerPaused,
            queueSize: taskStatus.queueSize,
            currentTask: taskStatus.currentTask
              ? {
                  id: taskStatus.currentTask.id,
                  type: taskStatus.currentTask.type,
                  status: taskStatus.currentTask.status,
                }
              : null,
            counts: taskStatus.counts,
            lastSuccessful: taskStatus.lastSuccessful
              ? {
                  id: taskStatus.lastSuccessful.id,
                  type: taskStatus.lastSuccessful.type,
                  completedAt: taskStatus.lastSuccessful.completedAt,
                }
              : null,
          }
        : null,
      persistence: {
        running: Boolean(this.persistence?.isRunning?.()),
        lastSaveAt: this.persistence?.lastSaveAt ?? null,
      },
      lastError: this.lastError,
    };
  }
}
