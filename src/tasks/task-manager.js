import { TaskQueue } from './task-queue.js';
import { TaskRegistry } from './task-registry.js';
import { TaskWorker } from './task-worker.js';
import { TaskRecovery } from './task-recovery.js';
import { healthCheckHandler } from './handlers/health-check.js';
import { RetryManager } from '../execution/retry-manager.js';
import { ConcurrencyManager } from '../execution/concurrency-manager.js';
import { IdempotencyManager } from '../execution/idempotency-manager.js';
import { DEMO_TASK_TYPE } from './constants.js';

/**
 * High-level facade for enqueueing and operating the task engine.
 */
export class TaskManager {
  /**
   * @param {{
   *   tasks: import('../storage/repositories/task-repository.js').TaskRepository,
   *   events: import('../storage/repositories/event-repository.js').EventRepository,
   *   registry?: TaskRegistry,
   *   logger: {
   *     info: Function,
   *     warn: Function,
   *     error: Function,
   *     debug: Function,
   *   },
   *   concurrencyLimit?: number,
   *   retryBaseMs?: number,
   *   retryMaxMs?: number,
   *   staleTimeoutMs?: number,
   *   pollIntervalMs?: number,
   *   signal?: AbortSignal | null,
   *   createContext?: (task: object) => import('./types.js').TaskExecutionContext,
   *   healthCheck?: () => Promise<{ ok: boolean, reason?: string, pauseAuthTasks?: boolean }>,
   *   eventsBus?: import('../core/event-bus.js').EventBus | null,
   *   registerDemoHandler?: boolean,
   * }} options
   */
  constructor(options) {
    this.tasks = options.tasks;
    this.eventRepo = options.events;
    this.logger = options.logger;
    this.registry = options.registry ?? new TaskRegistry();
    this.idempotency = new IdempotencyManager();
    this.queue = new TaskQueue({
      tasks: this.tasks,
      events: this.eventRepo,
      idempotency: this.idempotency,
    });
    this.recovery = new TaskRecovery({
      tasks: this.tasks,
      events: this.eventRepo,
      staleTimeoutMs: options.staleTimeoutMs,
      logger: this.logger,
    });
    this.worker = new TaskWorker({
      queue: this.queue,
      tasks: this.tasks,
      events: this.eventRepo,
      registry: this.registry,
      retryManager: new RetryManager({
        baseMs: options.retryBaseMs,
        maxMs: options.retryMaxMs,
      }),
      concurrency: new ConcurrencyManager({
        limit: options.concurrencyLimit ?? 1,
      }),
      logger: this.logger,
      createContext: options.createContext,
      healthCheck: options.healthCheck,
      pollIntervalMs: options.pollIntervalMs,
      signal: options.signal,
      eventsBus: options.eventsBus,
    });

    if (options.registerDemoHandler !== false && !this.registry.has(DEMO_TASK_TYPE)) {
      this.registry.register(healthCheckHandler);
    }
  }

  /**
   * Recover stale work and start the worker loop.
   *
   * @returns {Promise<void>}
   */
  async start() {
    this.recovery.recoverStaleTasks();
    return this.worker.start();
  }

  /**
   * @returns {Promise<void>}
   */
  async stop() {
    await this.worker.stop();
  }

  pause() {
    this.worker.pause();
  }

  resume() {
    this.worker.resume();
  }

  /**
   * @param {import('./types.js').TaskHandler} handler
   */
  registerHandler(handler) {
    this.registry.register(handler);
    return this;
  }

  /**
   * @param {Parameters<TaskQueue['enqueue']>[0]} input
   */
  enqueue(input) {
    return this.queue.enqueue(input);
  }

  /**
   * Enqueue the internal demo health-check task.
   *
   * @param {{ note?: string, idempotencyKey?: string }} [options]
   */
  enqueueHealthCheck(options = {}) {
    return this.enqueue({
      type: DEMO_TASK_TYPE,
      payload: { note: options.note ?? 'startup-health-check' },
      priority: 1,
      idempotencyKey: options.idempotencyKey ?? null,
    });
  }

  /**
   * @param {{ limit?: number }} [options]
   */
  listJobs(options = {}) {
    return this.queue.list({ limit: options.limit ?? 20 });
  }

  /**
   * @returns {object}
   */
  getStatus() {
    const counts = this.tasks.countByStatus();
    return {
      workerRunning: this.worker.isRunning(),
      workerPaused: this.worker.isPaused(),
      currentTask: this.worker.getCurrentTask(),
      queueSize: this.queue.size(),
      counts,
      lastSuccessful: this.tasks.getLastSuccessful(),
      registeredHandlers: this.registry.listTypes(),
    };
  }
}
