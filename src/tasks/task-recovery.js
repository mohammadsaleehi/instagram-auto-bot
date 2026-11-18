import { TaskEventType, TaskStatus } from './constants.js';
import { assertTransition } from './task-state-machine.js';

/**
 * Recover stale RUNNING tasks after a crash.
 *
 * Policy:
 * - If side_effect_started is true → NEEDS_ATTENTION (never blind replay)
 * - Otherwise → PENDING for a safe retry (attempt already counted)
 */
export class TaskRecovery {
  /**
   * @param {{
   *   tasks: import('../storage/repositories/task-repository.js').TaskRepository,
   *   events: import('../storage/repositories/event-repository.js').EventRepository,
   *   staleTimeoutMs?: number,
   *   logger?: {
   *     info?: Function,
   *     warn?: Function,
   *     error?: Function,
   *   },
   *   nowFn?: () => Date,
   * }} options
   */
  constructor(options) {
    this.tasks = options.tasks;
    this.events = options.events;
    this.staleTimeoutMs = options.staleTimeoutMs ?? 60_000;
    this.logger = options.logger ?? null;
    this._now = options.nowFn ?? (() => new Date());
  }

  /**
   * @returns {{ recovered: object[], needsAttention: object[] }}
   */
  recoverStaleTasks() {
    const stale = this.tasks.findStaleRunning(this.staleTimeoutMs, this._now());
    /** @type {object[]} */
    const recovered = [];
    /** @type {object[]} */
    const needsAttention = [];

    for (const task of stale) {
      if (!task) {
        continue;
      }

      if (task.sideEffectStarted) {
        assertTransition(TaskStatus.RUNNING, TaskStatus.NEEDS_ATTENTION);
        const updated = this.tasks.update(task.id, {
          status: TaskStatus.NEEDS_ATTENTION,
          lastError: {
            message:
              'Task was RUNNING during an uncertain external side effect when the process stopped',
            errorClass: 'UNKNOWN',
            code: 'STALE_SIDE_EFFECT',
          },
          clearClaim: true,
        });
        this.events.append({
          taskId: task.id,
          eventType: TaskEventType.NEEDS_ATTENTION,
          previousState: TaskStatus.RUNNING,
          newState: TaskStatus.NEEDS_ATTENTION,
          error: updated?.lastError,
          meta: { reason: 'stale_side_effect' },
        });
        needsAttention.push(updated);
        this.logger?.warn?.('Recovered stale task to NEEDS_ATTENTION', {
          taskId: task.id,
          type: task.type,
        });
        continue;
      }

      assertTransition(TaskStatus.RUNNING, TaskStatus.PENDING);
      const updated = this.tasks.update(task.id, {
        status: TaskStatus.PENDING,
        nextAttemptAt: this._now().toISOString(),
        lastError: {
          message: 'Task was RUNNING when the process stopped; re-queued safely',
          errorClass: 'UNKNOWN',
          code: 'STALE_RUNNING',
        },
        clearClaim: true,
      });
      this.events.append({
        taskId: task.id,
        eventType: TaskEventType.RECOVERED,
        previousState: TaskStatus.RUNNING,
        newState: TaskStatus.PENDING,
        error: updated?.lastError,
        meta: { reason: 'stale_running' },
      });
      recovered.push(updated);
      this.logger?.warn?.('Recovered stale task to PENDING', {
        taskId: task.id,
        type: task.type,
      });
    }

    return { recovered, needsAttention };
  }
}
