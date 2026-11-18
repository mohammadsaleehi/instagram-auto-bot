import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PRIORITY,
  TaskStatus,
} from '../../tasks/constants.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
function toJson(value) {
  return JSON.stringify(value ?? null);
}

/**
 * @param {string | null | undefined} value
 * @param {unknown} [fallback]
 * @returns {unknown}
 */
function fromJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapTaskRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    type: String(row.type),
    payload: fromJson(/** @type {string} */ (row.payload), {}),
    status: String(row.status),
    priority: Number(row.priority),
    scheduledAt: row.scheduled_at ? String(row.scheduled_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    lastError: fromJson(/** @type {string} */ (row.last_error), null),
    resultMetadata: fromJson(/** @type {string} */ (row.result_metadata), null),
    claimedBy: row.claimed_by ? String(row.claimed_by) : null,
    claimedAt: row.claimed_at ? String(row.claimed_at) : null,
    sideEffectStarted: Boolean(row.side_effect_started),
    scheduleId: row.schedule_id ? String(row.schedule_id) : null,
  };
}

export class TaskRepository {
  /**
   * @param {import('../database.js').Database} database
   * @param {{ nowFn?: () => Date, idFn?: () => string }} [options]
   */
  constructor(database, options = {}) {
    this.db = database;
    this._now = options.nowFn ?? (() => new Date());
    this._id = options.idFn ?? (() => randomUUID());
  }

  /**
   * @returns {string}
   */
  _isoNow() {
    return this._now().toISOString();
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
   *   id?: string,
   *   status?: string,
   * }} input
   */
  create(input) {
    const now = this._isoNow();
    const id = input.id ?? this._id();
    const scheduledAt = input.scheduledAt
      ? input.scheduledAt instanceof Date
        ? input.scheduledAt.toISOString()
        : String(input.scheduledAt)
      : now;
    const status = input.status ?? TaskStatus.PENDING;

    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return { task: existing, created: false };
      }
    }

    try {
      this.db.raw
        .prepare(
          `INSERT INTO tasks (
            id, type, payload, status, priority, scheduled_at, created_at, updated_at,
            attempt_count, max_attempts, next_attempt_at, idempotency_key, schedule_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.type,
          toJson(input.payload ?? {}),
          status,
          input.priority ?? DEFAULT_PRIORITY,
          scheduledAt,
          now,
          now,
          input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
          scheduledAt,
          input.idempotencyKey ?? null,
          input.scheduleId ?? null,
        );
    } catch (error) {
      if (input.idempotencyKey) {
        const existing = this.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          return { task: existing, created: false };
        }
      }
      throw error;
    }

    return { task: this.getById(id), created: true };
  }

  /**
   * @param {string} id
   */
  getById(id) {
    const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return mapTaskRow(/** @type {Record<string, unknown>} */ (row));
  }

  /**
   * @param {string} key
   */
  findByIdempotencyKey(key) {
    const row = this.db.raw
      .prepare('SELECT * FROM tasks WHERE idempotency_key = ?')
      .get(key);
    return mapTaskRow(/** @type {Record<string, unknown>} */ (row));
  }

  /**
   * Claim the next runnable task transactionally for a single worker.
   *
   * @param {{ workerId: string, now?: Date }} options
   */
  claimNext(options) {
    const now = (options.now ?? this._now()).toISOString();
    const workerId = options.workerId;

    return this.db.transaction(() => {
      const row = this.db.raw
        .prepare(
          `SELECT * FROM tasks
           WHERE status = ?
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND (scheduled_at IS NULL OR scheduled_at <= ?)
           ORDER BY priority DESC, scheduled_at ASC, created_at ASC
           LIMIT 1`,
        )
        .get(TaskStatus.PENDING, now, now);

      if (!row) {
        return null;
      }

      const taskId = String(row.id);
      const updated = this.db.raw
        .prepare(
          `UPDATE tasks
           SET status = ?,
               claimed_by = ?,
               claimed_at = ?,
               started_at = COALESCE(started_at, ?),
               attempt_count = attempt_count + 1,
               updated_at = ?,
               next_attempt_at = NULL
           WHERE id = ? AND status = ?`,
        )
        .run(
          TaskStatus.RUNNING,
          workerId,
          now,
          now,
          now,
          taskId,
          TaskStatus.PENDING,
        );

      if (updated.changes !== 1) {
        return null;
      }

      return this.getById(taskId);
    });
  }

  /**
   * @param {string} id
   * @param {{
   *   status?: string,
   *   lastError?: unknown,
   *   resultMetadata?: unknown,
   *   nextAttemptAt?: string | null,
   *   completedAt?: string | null,
   *   sideEffectStarted?: boolean,
   *   clearClaim?: boolean,
   * }} patch
   */
  update(id, patch) {
    const current = this.getById(id);
    if (!current) {
      return null;
    }

    const now = this._isoNow();
    const status = patch.status ?? current.status;
    const lastError =
      patch.lastError === undefined ? current.lastError : patch.lastError;
    const resultMetadata =
      patch.resultMetadata === undefined
        ? current.resultMetadata
        : patch.resultMetadata;
    const nextAttemptAt =
      patch.nextAttemptAt === undefined
        ? current.nextAttemptAt
        : patch.nextAttemptAt;
    const completedAt =
      patch.completedAt === undefined ? current.completedAt : patch.completedAt;
    const sideEffectStarted =
      patch.sideEffectStarted === undefined
        ? current.sideEffectStarted
        : patch.sideEffectStarted;

    this.db.raw
      .prepare(
        `UPDATE tasks SET
          status = ?,
          last_error = ?,
          result_metadata = ?,
          next_attempt_at = ?,
          completed_at = ?,
          side_effect_started = ?,
          claimed_by = CASE WHEN ? THEN NULL ELSE claimed_by END,
          claimed_at = CASE WHEN ? THEN NULL ELSE claimed_at END,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        status,
        lastError == null ? null : toJson(lastError),
        resultMetadata == null ? null : toJson(resultMetadata),
        nextAttemptAt,
        completedAt,
        sideEffectStarted ? 1 : 0,
        patch.clearClaim ? 1 : 0,
        patch.clearClaim ? 1 : 0,
        now,
        id,
      );

    return this.getById(id);
  }

  /**
   * Mark that an external side effect may have started for this attempt.
   *
   * @param {string} id
   */
  markSideEffectStarted(id) {
    return this.update(id, { sideEffectStarted: true });
  }

  /**
   * @param {{ status?: string | string[], limit?: number, offset?: number }} [options]
   */
  list(options = {}) {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const statuses = options.status
      ? Array.isArray(options.status)
        ? options.status
        : [options.status]
      : null;

    if (statuses) {
      const placeholders = statuses.map(() => '?').join(', ');
      const rows = this.db.raw
        .prepare(
          `SELECT * FROM tasks
           WHERE status IN (${placeholders})
           ORDER BY updated_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...statuses, limit, offset);
      return rows.map((row) => mapTaskRow(/** @type {Record<string, unknown>} */ (row)));
    }

    const rows = this.db.raw
      .prepare(
        `SELECT * FROM tasks
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
    return rows.map((row) => mapTaskRow(/** @type {Record<string, unknown>} */ (row)));
  }

  /**
   * @returns {Record<string, number>}
   */
  countByStatus() {
    const rows = this.db.raw
      .prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status')
      .all();
    /** @type {Record<string, number>} */
    const result = {};
    for (const row of rows) {
      result[String(row.status)] = Number(row.count);
    }
    return result;
  }

  /**
   * @returns {ReturnType<typeof mapTaskRow> | null}
   */
  getRunning() {
    const row = this.db.raw
      .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY started_at DESC LIMIT 1')
      .get(TaskStatus.RUNNING);
    return mapTaskRow(/** @type {Record<string, unknown>} */ (row));
  }

  /**
   * @returns {ReturnType<typeof mapTaskRow> | null}
   */
  getLastSuccessful() {
    const row = this.db.raw
      .prepare(
        `SELECT * FROM tasks
         WHERE status = ?
         ORDER BY completed_at DESC
         LIMIT 1`,
      )
      .get(TaskStatus.COMPLETED);
    return mapTaskRow(/** @type {Record<string, unknown>} */ (row));
  }

  /**
   * Find RUNNING tasks whose claim is older than the stale timeout.
   *
   * @param {number} staleTimeoutMs
   * @param {Date} [now]
   */
  findStaleRunning(staleTimeoutMs, now = this._now()) {
    const cutoff = new Date(now.getTime() - staleTimeoutMs).toISOString();
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM tasks
         WHERE status = ?
           AND claimed_at IS NOT NULL
           AND claimed_at < ?`,
      )
      .all(TaskStatus.RUNNING, cutoff);
    return rows.map((row) => mapTaskRow(/** @type {Record<string, unknown>} */ (row)));
  }

  /**
   * @returns {number}
   */
  pendingCount() {
    const row = this.db.raw
      .prepare('SELECT COUNT(*) AS count FROM tasks WHERE status = ?')
      .get(TaskStatus.PENDING);
    return Number(row?.count ?? 0);
  }
}
