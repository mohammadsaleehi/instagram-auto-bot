/**
 * Initial schema for the single-account automation engine.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      scheduled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_attempt_at TEXT,
      idempotency_key TEXT,
      last_error TEXT,
      result_metadata TEXT,
      claimed_by TEXT,
      claimed_at TEXT,
      side_effect_started INTEGER NOT NULL DEFAULT 0,
      schedule_id TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency
      ON tasks(idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_tasks_claimable
      ON tasks(status, priority DESC, scheduled_at ASC, created_at ASC);

    CREATE INDEX IF NOT EXISTS idx_tasks_next_attempt
      ON tasks(status, next_attempt_at);

    CREATE INDEX IF NOT EXISTS idx_tasks_status_updated
      ON tasks(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      previous_state TEXT,
      new_state TEXT,
      duration_ms INTEGER,
      result_json TEXT,
      error_json TEXT,
      meta_json TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_events_task_time
      ON task_events(task_id, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_task_events_time
      ON task_events(timestamp DESC);

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY NOT NULL,
      task_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      cron_expression TEXT,
      interval_ms INTEGER,
      timezone TEXT NOT NULL DEFAULT 'Europe/Berlin',
      next_run_at TEXT,
      last_enqueued_at TEXT,
      last_enqueued_for TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      catch_up_policy TEXT NOT NULL DEFAULT 'skip_missed',
      max_catch_up INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      idempotency_prefix TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_next_run
      ON schedules(enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export const version = 1;
export const name = '001-initial';
