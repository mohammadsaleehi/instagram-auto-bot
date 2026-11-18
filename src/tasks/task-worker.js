import { setTimeout as delay } from 'node:timers/promises';
import {
  ErrorClass,
  TaskError,
  TaskEventType,
  TaskStatus,
} from './constants.js';
import { assertTransition } from './task-state-machine.js';
import { throwIfAborted, ShutdownError } from '../utils/shutdown.js';
import { ConcurrencyManager } from '../execution/concurrency-manager.js';
import { RetryManager } from '../execution/retry-manager.js';

/**
 * Single worker that claims and executes persistent tasks.
 */
export class TaskWorker {
  /**
   * @param {{
   *   workerId?: string,
   *   queue: import('./task-queue.js').TaskQueue,
   *   tasks: import('../storage/repositories/task-repository.js').TaskRepository,
   *   events: import('../storage/repositories/event-repository.js').EventRepository,
   *   registry: import('./task-registry.js').TaskRegistry,
   *   retryManager?: RetryManager,
   *   concurrency?: ConcurrencyManager,
   *   logger: {
   *     info: Function,
   *     warn: Function,
   *     error: Function,
   *     debug: Function,
   *   },
   *   createContext?: (task: object) => import('./types.js').TaskExecutionContext,
   *   healthCheck?: () => Promise<{ ok: boolean, reason?: string, pauseAuthTasks?: boolean }>,
   *   pollIntervalMs?: number,
   *   signal?: AbortSignal | null,
   *   eventsBus?: import('../core/event-bus.js').EventBus | null,
   * }} options
   */
  constructor(options) {
    this.workerId = options.workerId ?? `worker-${process.pid}`;
    this.queue = options.queue;
    this.tasks = options.tasks;
    this.events = options.events;
    this.registry = options.registry;
    this.retryManager = options.retryManager ?? new RetryManager();
    this.concurrency = options.concurrency ?? new ConcurrencyManager({ limit: 1 });
    this.logger = options.logger;
    this.createContext = options.createContext ?? ((task) => ({
      logger: this.logger,
      task,
    }));
    this.healthCheck = options.healthCheck ?? (async () => ({ ok: true }));
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.signal = options.signal ?? null;
    this.eventsBus = options.eventsBus ?? null;

    this._paused = false;
    this._running = false;
    this._loopPromise = null;
    /** @type {AbortController | null} */
    this._taskAbort = null;
    /** @type {object | null} */
    this._currentTask = null;
  }

  /**
   * @returns {boolean}
   */
  isPaused() {
    return this._paused;
  }

  /**
   * @returns {boolean}
   */
  isRunning() {
    return this._running;
  }

  /**
   * @returns {object | null}
   */
  getCurrentTask() {
    return this._currentTask;
  }

  /**
   * @returns {void}
   */
  pause() {
    if (this._paused) {
      return;
    }
    this._paused = true;
    this.logger.info('Task worker paused');
    this.eventsBus?.emit('worker.paused', { workerId: this.workerId });
  }

  /**
   * @returns {void}
   */
  resume() {
    if (!this._paused) {
      return;
    }
    this._paused = false;
    this.logger.info('Task worker resumed');
    this.eventsBus?.emit('worker.resumed', { workerId: this.workerId });
  }

  /**
   * Start the polling loop.
   *
   * @returns {Promise<void>}
   */
  start() {
    if (this._running) {
      return this._loopPromise ?? Promise.resolve();
    }
    this._running = true;
    this._loopPromise = this._loop().finally(() => {
      this._running = false;
      this._loopPromise = null;
    });
    return this._loopPromise;
  }

  /**
   * Request stop; waits for the current task when possible.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    this._running = false;
    this._taskAbort?.abort(
      new ShutdownError('Worker stop requested', { code: 'SHUTDOWN_REQUESTED' }),
    );
    if (this._loopPromise) {
      await this._loopPromise;
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async _loop() {
    this.logger.info('Task worker started', { workerId: this.workerId });

    while (this._running && !this.signal?.aborted) {
      if (this._paused || !this.concurrency.canAcquire()) {
        await this._idleWait();
        continue;
      }

      let claimed = null;
      try {
        claimed = this.queue.claimNext({ workerId: this.workerId });
      } catch (error) {
        this.logger.error('Failed to claim next task', {
          error: error instanceof Error ? error.message : String(error),
        });
        await this._idleWait();
        continue;
      }

      if (!claimed) {
        await this._idleWait();
        continue;
      }

      await this.concurrency.run(async () => {
        await this._executeClaimed(claimed);
      });
    }

    this.logger.info('Task worker stopped', { workerId: this.workerId });
  }

  /**
   * @returns {Promise<void>}
   */
  async _idleWait() {
    try {
      await delay(this.pollIntervalMs, undefined, { signal: this.signal ?? undefined });
    } catch {
      // aborted
    }
  }

  /**
   * @param {object} task
   */
  async _executeClaimed(task) {
    this._currentTask = task;
    this._taskAbort = new AbortController();
    const onParentAbort = () => {
      this._taskAbort?.abort(this.signal?.reason);
    };
    this.signal?.addEventListener('abort', onParentAbort, { once: true });

    const startedAt = Date.now();
    this.events.append({
      taskId: task.id,
      eventType: TaskEventType.STARTED,
      previousState: TaskStatus.RUNNING,
      newState: TaskStatus.RUNNING,
      meta: { attempt: task.attemptCount },
    });

    try {
      throwIfAborted(this.signal);
      throwIfAborted(this._taskAbort.signal);

      const latest = this.tasks.getById(task.id);
      if (latest?.status === TaskStatus.CANCELLED) {
        return;
      }

      const handler = this.registry.get(task.type);
      if (!handler) {
        throw new TaskError(`No handler registered for task type: ${task.type}`, {
          code: 'HANDLER_NOT_FOUND',
          errorClass: ErrorClass.INVALID_INPUT,
          retryable: false,
        });
      }

      const health = await this.healthCheck();
      if (!health.ok) {
        if (health.pauseAuthTasks && handler.requiresAuth !== false) {
          throw new TaskError(health.reason ?? 'Authentication required', {
            code: 'AUTHENTICATION_REQUIRED',
            errorClass: ErrorClass.AUTHENTICATION_REQUIRED,
            retryable: false,
          });
        }
        if (handler.requiresAuth) {
          throw new TaskError(health.reason ?? 'Application unhealthy', {
            code: 'HEALTH_CHECK_FAILED',
            errorClass: ErrorClass.AUTHENTICATION_REQUIRED,
            retryable: false,
          });
        }
      }

      const context = this.createContext(task);
      let sideEffectStarted = Boolean(task.sideEffectStarted);
      context.markSideEffect = (started = true) => {
        sideEffectStarted = Boolean(started);
        if (sideEffectStarted) {
          this.tasks.markSideEffectStarted(task.id);
        }
      };

      if (handler.externalSideEffect) {
        context.markSideEffect(true);
      }

      const result = await handler.execute(
        context,
        /** @type {Record<string, unknown>} */ (task.payload ?? {}),
        this._taskAbort.signal,
      );

      const durationMs = Date.now() - startedAt;
      assertTransition(TaskStatus.RUNNING, TaskStatus.COMPLETED);
      this.tasks.update(task.id, {
        status: TaskStatus.COMPLETED,
        resultMetadata: sanitizeResult(result),
        completedAt: new Date().toISOString(),
        clearClaim: true,
        sideEffectStarted,
      });
      this.events.append({
        taskId: task.id,
        eventType: TaskEventType.COMPLETED,
        previousState: TaskStatus.RUNNING,
        newState: TaskStatus.COMPLETED,
        durationMs,
        result: sanitizeResult(result),
      });
      this.logger.info('Task completed', {
        taskId: task.id,
        type: task.type,
        durationMs,
      });
      this.eventsBus?.emit('task.completed', { taskId: task.id, type: task.type });
    } catch (error) {
      await this._handleFailure(task, error, Date.now() - startedAt);
    } finally {
      this.signal?.removeEventListener('abort', onParentAbort);
      this._taskAbort = null;
      this._currentTask = null;
    }
  }

  /**
   * @param {object} task
   * @param {unknown} error
   * @param {number} durationMs
   */
  async _handleFailure(task, error, durationMs) {
    const current = this.tasks.getById(task.id) ?? task;
    if (current.status === TaskStatus.CANCELLED) {
      return;
    }

    const decision = this.retryManager.decide({
      attemptCount: current.attemptCount,
      maxAttempts: current.maxAttempts,
      error,
      sideEffectStarted: Boolean(current.sideEffectStarted),
    });

    if (decision.action === 'retry') {
      assertTransition(TaskStatus.RUNNING, TaskStatus.PENDING);
      this.tasks.update(task.id, {
        status: TaskStatus.PENDING,
        lastError: decision.error,
        nextAttemptAt: decision.nextAttemptAt,
        clearClaim: true,
      });
      this.events.append({
        taskId: task.id,
        eventType: TaskEventType.RETRY_SCHEDULED,
        previousState: TaskStatus.RUNNING,
        newState: TaskStatus.PENDING,
        durationMs,
        error: decision.error,
        meta: { delayMs: decision.delayMs, reason: decision.reason },
      });
      this.logger.warn('Task scheduled for retry', {
        taskId: task.id,
        type: task.type,
        nextAttemptAt: decision.nextAttemptAt,
        errorClass: decision.error.errorClass,
      });
      return;
    }

    if (decision.action === 'needs_attention' || decision.action === 'cancel') {
      const nextStatus =
        decision.action === 'cancel'
          ? TaskStatus.CANCELLED
          : TaskStatus.NEEDS_ATTENTION;
      assertTransition(TaskStatus.RUNNING, nextStatus);
      this.tasks.update(task.id, {
        status: nextStatus,
        lastError: decision.error,
        completedAt: new Date().toISOString(),
        clearClaim: true,
      });
      this.events.append({
        taskId: task.id,
        eventType:
          nextStatus === TaskStatus.CANCELLED
            ? TaskEventType.CANCELLED
            : TaskEventType.NEEDS_ATTENTION,
        previousState: TaskStatus.RUNNING,
        newState: nextStatus,
        durationMs,
        error: decision.error,
        meta: { reason: decision.reason },
      });

      if (nextStatus === TaskStatus.NEEDS_ATTENTION) {
        this.logger.error('Task needs attention', {
          taskId: task.id,
          type: task.type,
          reason: decision.reason,
          errorClass: decision.error.errorClass,
        });
        if (
          decision.error.errorClass === ErrorClass.AUTHENTICATION_REQUIRED ||
          decision.error.errorClass === ErrorClass.VERIFICATION_REQUIRED
        ) {
          this.pause();
          this.eventsBus?.emit('auth.invalid', {
            taskId: task.id,
            errorClass: decision.error.errorClass,
            message: decision.error.message,
          });
        }
      }
      return;
    }

    assertTransition(TaskStatus.RUNNING, TaskStatus.FAILED);
    this.tasks.update(task.id, {
      status: TaskStatus.FAILED,
      lastError: decision.error,
      completedAt: new Date().toISOString(),
      clearClaim: true,
    });
    this.events.append({
      taskId: task.id,
      eventType: TaskEventType.FAILED,
      previousState: TaskStatus.RUNNING,
      newState: TaskStatus.FAILED,
      durationMs,
      error: decision.error,
      meta: { reason: decision.reason },
    });
    this.logger.error('Task failed', {
      taskId: task.id,
      type: task.type,
      errorClass: decision.error.errorClass,
      message: decision.error.message,
    });
  }
}

/**
 * @param {unknown} result
 * @returns {unknown}
 */
function sanitizeResult(result) {
  if (result == null) {
    return null;
  }
  if (typeof result !== 'object') {
    return result;
  }

  const sensitive =
    /^(pass(word)?|secret|token|cookie|authorization|storage.?state|session|username|credentials?)$/i;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(result)) {
    out[key] = sensitive.test(key) ? '[REDACTED]' : value;
  }
  return out;
}
