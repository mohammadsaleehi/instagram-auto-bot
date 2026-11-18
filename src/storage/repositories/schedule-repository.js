import { randomUUID } from 'node:crypto';

/**
 * @param {Record<string, unknown>} row
 */
export function mapScheduleRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    taskType: String(row.task_type),
    payload: parseJson(/** @type {string} */ (row.payload), {}),
    cronExpression: row.cron_expression ? String(row.cron_expression) : null,
    intervalMs: row.interval_ms == null ? null : Number(row.interval_ms),
    timezone: String(row.timezone),
    nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
    lastEnqueuedAt: row.last_enqueued_at ? String(row.last_enqueued_at) : null,
    lastEnqueuedFor: row.last_enqueued_for ? String(row.last_enqueued_for) : null,
    enabled: Boolean(row.enabled),
    catchUpPolicy: String(row.catch_up_policy),
    maxCatchUp: Number(row.max_catch_up),
    priority: Number(row.priority),
    maxAttempts: Number(row.max_attempts),
    idempotencyPrefix: row.idempotency_prefix
      ? String(row.idempotency_prefix)
      : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * @param {string | null | undefined} value
 * @param {unknown} [fallback]
 */
function parseJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class ScheduleRepository {
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
   * @param {{
   *   id?: string,
   *   taskType: string,
   *   payload?: Record<string, unknown>,
   *   cronExpression?: string | null,
   *   intervalMs?: number | null,
   *   timezone?: string,
   *   nextRunAt?: string | null,
   *   enabled?: boolean,
   *   catchUpPolicy?: string,
   *   maxCatchUp?: number,
   *   priority?: number,
   *   maxAttempts?: number,
   *   idempotencyPrefix?: string | null,
   * }} input
   */
  upsert(input) {
    const now = this._now().toISOString();
    const id = input.id ?? this._id();
    const existing = this.getById(id);

    if (existing) {
      this.db.raw
        .prepare(
          `UPDATE schedules SET
            task_type = ?,
            payload = ?,
            cron_expression = ?,
            interval_ms = ?,
            timezone = ?,
            next_run_at = ?,
            enabled = ?,
            catch_up_policy = ?,
            max_catch_up = ?,
            priority = ?,
            max_attempts = ?,
            idempotency_prefix = ?,
            updated_at = ?
          WHERE id = ?`,
        )
        .run(
          input.taskType,
          JSON.stringify(input.payload ?? {}),
          input.cronExpression ?? null,
          input.intervalMs ?? null,
          input.timezone ?? existing.timezone,
          input.nextRunAt ?? existing.nextRunAt,
          (input.enabled ?? existing.enabled) ? 1 : 0,
          input.catchUpPolicy ?? existing.catchUpPolicy,
          input.maxCatchUp ?? existing.maxCatchUp,
          input.priority ?? existing.priority,
          input.maxAttempts ?? existing.maxAttempts,
          input.idempotencyPrefix ?? existing.idempotencyPrefix,
          now,
          id,
        );
      return this.getById(id);
    }

    this.db.raw
      .prepare(
        `INSERT INTO schedules (
          id, task_type, payload, cron_expression, interval_ms, timezone,
          next_run_at, enabled, catch_up_policy, max_catch_up, priority,
          max_attempts, idempotency_prefix, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskType,
        JSON.stringify(input.payload ?? {}),
        input.cronExpression ?? null,
        input.intervalMs ?? null,
        input.timezone ?? 'Europe/Berlin',
        input.nextRunAt ?? now,
        (input.enabled ?? true) ? 1 : 0,
        input.catchUpPolicy ?? 'skip_missed',
        input.maxCatchUp ?? 1,
        input.priority ?? 100,
        input.maxAttempts ?? 3,
        input.idempotencyPrefix ?? null,
        now,
        now,
      );

    return this.getById(id);
  }

  /**
   * @param {string} id
   */
  getById(id) {
    const row = this.db.raw.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
    return mapScheduleRow(/** @type {Record<string, unknown>} */ (row));
  }

  /**
   * @returns {ReturnType<typeof mapScheduleRow>[]}
   */
  listEnabledDue(nowIso) {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM schedules
         WHERE enabled = 1
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?
         ORDER BY next_run_at ASC`,
      )
      .all(nowIso);
    return rows.map((row) => mapScheduleRow(/** @type {Record<string, unknown>} */ (row)));
  }

  /**
   * @returns {ReturnType<typeof mapScheduleRow>[]}
   */
  listAll() {
    const rows = this.db.raw
      .prepare('SELECT * FROM schedules ORDER BY created_at ASC')
      .all();
    return rows.map((row) => mapScheduleRow(/** @type {Record<string, unknown>} */ (row)));
  }

  /**
   * @param {string} id
   * @param {{
   *   nextRunAt?: string | null,
   *   lastEnqueuedAt?: string | null,
   *   lastEnqueuedFor?: string | null,
   *   enabled?: boolean,
   * }} patch
   */
  update(id, patch) {
    const current = this.getById(id);
    if (!current) {
      return null;
    }

    const now = this._now().toISOString();
    this.db.raw
      .prepare(
        `UPDATE schedules SET
          next_run_at = ?,
          last_enqueued_at = ?,
          last_enqueued_for = ?,
          enabled = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        patch.nextRunAt === undefined ? current.nextRunAt : patch.nextRunAt,
        patch.lastEnqueuedAt === undefined
          ? current.lastEnqueuedAt
          : patch.lastEnqueuedAt,
        patch.lastEnqueuedFor === undefined
          ? current.lastEnqueuedFor
          : patch.lastEnqueuedFor,
        (patch.enabled === undefined ? current.enabled : patch.enabled) ? 1 : 0,
        now,
        id,
      );

    return this.getById(id);
  }
}
