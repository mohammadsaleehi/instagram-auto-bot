/**
 * Durable task-event audit log.
 */
export class EventRepository {
  /**
   * @param {import('../database.js').Database} database
   * @param {{ nowFn?: () => Date }} [options]
   */
  constructor(database, options = {}) {
    this.db = database;
    this._now = options.nowFn ?? (() => new Date());
  }

  /**
   * @param {{
   *   taskId: string,
   *   eventType: string,
   *   previousState?: string | null,
   *   newState?: string | null,
   *   durationMs?: number | null,
   *   result?: unknown,
   *   error?: unknown,
   *   meta?: Record<string, unknown> | null,
   *   timestamp?: string,
   * }} input
   */
  append(input) {
    const timestamp = input.timestamp ?? this._now().toISOString();
    const result = this.db.raw
      .prepare(
        `INSERT INTO task_events (
          task_id, event_type, timestamp, previous_state, new_state,
          duration_ms, result_json, error_json, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.taskId,
        input.eventType,
        timestamp,
        input.previousState ?? null,
        input.newState ?? null,
        input.durationMs ?? null,
        input.result == null ? null : JSON.stringify(input.result),
        input.error == null ? null : JSON.stringify(input.error),
        input.meta == null ? null : JSON.stringify(input.meta),
      );

    return {
      id: Number(result.lastInsertRowid),
      taskId: input.taskId,
      eventType: input.eventType,
      timestamp,
    };
  }

  /**
   * @param {{ taskId?: string, limit?: number }} [options]
   */
  listRecent(options = {}) {
    const limit = options.limit ?? 50;
    if (options.taskId) {
      const rows = this.db.raw
        .prepare(
          `SELECT * FROM task_events
           WHERE task_id = ?
           ORDER BY timestamp DESC, id DESC
           LIMIT ?`,
        )
        .all(options.taskId, limit);
      return rows.map(mapEventRow);
    }

    const rows = this.db.raw
      .prepare(
        `SELECT * FROM task_events
         ORDER BY timestamp DESC, id DESC
         LIMIT ?`,
      )
      .all(limit);
    return rows.map(mapEventRow);
  }
}

/**
 * @param {Record<string, unknown>} row
 */
function mapEventRow(row) {
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    eventType: String(row.event_type),
    timestamp: String(row.timestamp),
    previousState: row.previous_state ? String(row.previous_state) : null,
    newState: row.new_state ? String(row.new_state) : null,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    result: parseJson(/** @type {string} */ (row.result_json)),
    error: parseJson(/** @type {string} */ (row.error_json)),
    meta: parseJson(/** @type {string} */ (row.meta_json)),
  };
}

/**
 * @param {string | null | undefined} value
 */
function parseJson(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
