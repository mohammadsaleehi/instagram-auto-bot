import { setTimeout as delay } from 'node:timers/promises';
import { IdempotencyManager } from '../execution/idempotency-manager.js';

/**
 * Persistent scheduler.
 *
 * Catch-up policy (default: skip_missed):
 * - When the app was offline past one or more slots, enqueue at most
 *   maxCatchUp occurrences (default 1) for the latest due slot.
 * - Never blindly drains a large backlog.
 * - Uses idempotency keys per schedule slot to prevent duplicates.
 */
export class Scheduler {
  /**
   * @param {{
   *   store: import('./schedule-store.js').ScheduleStore,
   *   enqueue: (input: {
   *     type: string,
   *     payload?: Record<string, unknown>,
   *     priority?: number,
   *     maxAttempts?: number,
   *     idempotencyKey?: string | null,
   *     scheduleId?: string | null,
   *     scheduledAt?: string | null,
   *   }) => { task: object | null, created: boolean },
   *   timezone?: string,
   *   pollIntervalMs?: number,
   *   logger: {
   *     info: Function,
   *     warn: Function,
   *     error: Function,
   *     debug: Function,
   *   },
   *   signal?: AbortSignal | null,
   *   nowFn?: () => Date,
   *   idempotency?: IdempotencyManager,
   *   onBeforeTick?: ((now: Date) => void) | null,
   * }} options
   */
  constructor(options) {
    this.store = options.store;
    this.enqueue = options.enqueue;
    this.timezone = options.timezone ?? 'Europe/Berlin';
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.logger = options.logger;
    this.signal = options.signal ?? null;
    this._now = options.nowFn ?? (() => new Date());
    this.idempotency = options.idempotency ?? new IdempotencyManager();
    this.onBeforeTick = options.onBeforeTick ?? null;

    this._running = false;
    /** @type {Promise<void> | null} */
    this._loopPromise = null;
  }

  /**
   * @returns {boolean}
   */
  isRunning() {
    return this._running;
  }

  /**
   * @param {{
   *   id?: string,
   *   taskType: string,
   *   payload?: Record<string, unknown>,
   *   runAt?: string | Date,
   *   intervalMs?: number | null,
   *   timezone?: string,
   *   catchUpPolicy?: 'skip_missed' | 'enqueue_latest',
   *   maxCatchUp?: number,
   *   priority?: number,
   *   maxAttempts?: number,
   *   idempotencyPrefix?: string | null,
   * }} input
   */
  schedule(input) {
    const nextRunAt = input.runAt
      ? input.runAt instanceof Date
        ? input.runAt.toISOString()
        : new Date(input.runAt).toISOString()
      : this._now().toISOString();

    return this.store.save({
      id: input.id,
      taskType: input.taskType,
      payload: input.payload ?? {},
      intervalMs: input.intervalMs ?? null,
      cronExpression: null,
      timezone: input.timezone ?? this.timezone,
      nextRunAt,
      catchUpPolicy: input.catchUpPolicy ?? 'skip_missed',
      maxCatchUp: input.maxCatchUp ?? 1,
      priority: input.priority,
      maxAttempts: input.maxAttempts,
      idempotencyPrefix: input.idempotencyPrefix ?? `schedule:${input.taskType}`,
      enabled: true,
    });
  }

  /**
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
   * @returns {Promise<void>}
   */
  async stop() {
    this._running = false;
    if (this._loopPromise) {
      await this._loopPromise;
    }
  }

  /**
   * Tick once — used by tests and the polling loop.
   *
   * @param {Date} [now]
   * @returns {{ enqueued: number }}
   */
  tick(now = this._now()) {
    if (typeof this.onBeforeTick === 'function') {
      this.onBeforeTick(now);
    }
    const nowIso = now.toISOString();
    const due = this.store.listDue(nowIso);
    let enqueued = 0;

    for (const schedule of due) {
      if (!schedule) {
        continue;
      }

      const slot = schedule.nextRunAt ?? nowIso;
      if (schedule.lastEnqueuedFor === slot) {
        // Already enqueued this slot; advance cursor only.
        this._advance(schedule, now);
        continue;
      }

      const maxCatchUp = Math.max(1, schedule.maxCatchUp ?? 1);
      // skip_missed / enqueue_latest: only enqueue the latest due slot (maxCatchUp times max 1 by default).
      const slotsToEnqueue = Math.min(maxCatchUp, 1);
      for (let i = 0; i < slotsToEnqueue; i += 1) {
        const idempotencyKey = this.idempotency.forScheduleSlot(
          schedule.idempotencyPrefix ?? `schedule:${schedule.id}`,
          slot,
        );
        const result = this.enqueue({
          type: schedule.taskType,
          payload: {
            ...(schedule.payload ?? {}),
            __scheduleId: schedule.id,
            __scheduledFor: slot,
          },
          priority: schedule.priority,
          maxAttempts: schedule.maxAttempts,
          idempotencyKey,
          scheduleId: schedule.id,
          scheduledAt: slot,
        });
        if (result.created) {
          enqueued += 1;
        }
      }

      this.store.update(schedule.id, {
        lastEnqueuedAt: nowIso,
        lastEnqueuedFor: slot,
      });
      this._advance(schedule, now);
    }

    return { enqueued };
  }

  /**
   * @param {NonNullable<ReturnType<import('../storage/repositories/schedule-repository.js').mapScheduleRow>>} schedule
   * @param {Date} now
   */
  _advance(schedule, now) {
    if (schedule.intervalMs && schedule.intervalMs > 0) {
      // Advance from the missed slot in interval steps, but land at most one interval ahead of now.
      let next = new Date(schedule.nextRunAt ?? now.toISOString()).getTime();
      const interval = schedule.intervalMs;
      const nowMs = now.getTime();
      // Skip missed intervals without enqueueing them.
      while (next <= nowMs) {
        next += interval;
      }
      this.store.update(schedule.id, {
        nextRunAt: new Date(next).toISOString(),
      });
      return;
    }

    // One-shot schedule: disable after enqueue.
    this.store.update(schedule.id, {
      enabled: false,
      nextRunAt: null,
    });
  }

  /**
   * @returns {Promise<void>}
   */
  async _loop() {
    this.logger.info('Scheduler started', { timezone: this.timezone });
    while (this._running && !this.signal?.aborted) {
      try {
        const { enqueued } = this.tick();
        if (enqueued > 0) {
          this.logger.info('Scheduler enqueued tasks', { enqueued });
        }
      } catch (error) {
        this.logger.error('Scheduler tick failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        await delay(this.pollIntervalMs, undefined, {
          signal: this.signal ?? undefined,
        });
      } catch {
        break;
      }
    }
    this.logger.info('Scheduler stopped');
  }
}
