import { TaskEventType, TaskStatus } from './constants.js';
import { IdempotencyManager } from '../execution/idempotency-manager.js';

/**
 * Persistent task queue facade over TaskRepository.
 */
export class TaskQueue {
  /**
   * @param {{
   *   tasks: import('../storage/repositories/task-repository.js').TaskRepository,
   *   events: import('../storage/repositories/event-repository.js').EventRepository,
   *   idempotency?: IdempotencyManager,
   * }} options
   */
  constructor(options) {
    this.tasks = options.tasks;
    this.events = options.events;
    this.idempotency = options.idempotency ?? new IdempotencyManager();
  }

  /**
   * @param {{
   *   type: string,
   *   payload?: Record<string, unknown>,
   *   priority?: number,
   *   scheduledAt?: string | Date | null,
   *   maxAttempts?: number,
   *   idempotencyKey?: string | null,
   *   scheduleId?: string | null,
   * }} input
   */
  enqueue(input) {
    const idempotencyKey = this.idempotency.normalize(input.idempotencyKey);
    const { task, created } = this.tasks.create({
      ...input,
      idempotencyKey,
      status: TaskStatus.PENDING,
    });

    if (created && task) {
      this.events.append({
        taskId: task.id,
        eventType: TaskEventType.CREATED,
        previousState: null,
        newState: TaskStatus.PENDING,
        meta: { type: task.type },
      });
    }

    return { task, created };
  }

  /**
   * @param {{ workerId: string }} options
   */
  claimNext(options) {
    const task = this.tasks.claimNext(options);
    if (!task) {
      return null;
    }

    this.events.append({
      taskId: task.id,
      eventType: TaskEventType.CLAIMED,
      previousState: TaskStatus.PENDING,
      newState: TaskStatus.RUNNING,
      meta: { workerId: options.workerId, attempt: task.attemptCount },
    });

    return task;
  }

  /**
   * @param {string} taskId
   * @param {{ reason?: string }} [options]
   */
  cancel(taskId, options = {}) {
    const task = this.tasks.getById(taskId);
    if (!task) {
      return null;
    }

    if (
      task.status === TaskStatus.COMPLETED ||
      task.status === TaskStatus.CANCELLED
    ) {
      return task;
    }

    if (task.status === TaskStatus.RUNNING) {
      // Cooperative cancel: mark CANCELLED; worker observes and stops.
      const updated = this.tasks.update(taskId, {
        status: TaskStatus.CANCELLED,
        completedAt: new Date().toISOString(),
        lastError: {
          message: options.reason ?? 'Cancelled while running',
          errorClass: 'CANCELLED',
          code: 'CANCELLED',
        },
        clearClaim: true,
      });
      this.events.append({
        taskId,
        eventType: TaskEventType.CANCELLED,
        previousState: TaskStatus.RUNNING,
        newState: TaskStatus.CANCELLED,
        error: updated?.lastError,
      });
      return updated;
    }

    const updated = this.tasks.update(taskId, {
      status: TaskStatus.CANCELLED,
      completedAt: new Date().toISOString(),
      lastError: {
        message: options.reason ?? 'Cancelled',
        errorClass: 'CANCELLED',
        code: 'CANCELLED',
      },
      clearClaim: true,
    });
    this.events.append({
      taskId,
      eventType: TaskEventType.CANCELLED,
      previousState: task.status,
      newState: TaskStatus.CANCELLED,
      error: updated?.lastError,
    });
    return updated;
  }

  /**
   * @param {{ limit?: number, status?: string | string[] }} [options]
   */
  list(options) {
    return this.tasks.list(options);
  }

  /**
   * @returns {number}
   */
  size() {
    return this.tasks.pendingCount();
  }
}
