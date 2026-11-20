/**
 * Canonical publication lifecycle metadata and transition events.
 *
 * Forward-only: existing operation/history rows are preserved and backfilled
 * with the canonical outcome. No records are deleted or recreated.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function up(db) {
  const operationColumns = new Set(
    db
      .prepare('PRAGMA table_info(story_publish_operations)')
      .all()
      .map((row) => String(row.name)),
  );
  if (!operationColumns.has('publication_outcome')) {
    db.exec('ALTER TABLE story_publish_operations ADD COLUMN publication_outcome TEXT');
  }

  const historyColumns = new Set(
    db
      .prepare('PRAGMA table_info(publishing_history)')
      .all()
      .map((row) => String(row.name)),
  );
  if (!historyColumns.has('publication_outcome')) {
    db.exec('ALTER TABLE publishing_history ADD COLUMN publication_outcome TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS publication_lifecycle_events (
      id TEXT PRIMARY KEY NOT NULL,
      operation_id TEXT,
      content_id TEXT,
      history_id TEXT,
      task_id TEXT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      event TEXT NOT NULL,
      previous_outcome TEXT,
      new_outcome TEXT,
      reason TEXT,
      evidence_json TEXT,
      FOREIGN KEY (operation_id) REFERENCES story_publish_operations(id) ON DELETE SET NULL,
      FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_publication_events_operation
      ON publication_lifecycle_events(operation_id, at ASC);

    CREATE INDEX IF NOT EXISTS idx_publication_events_content
      ON publication_lifecycle_events(content_id, at ASC);

    CREATE INDEX IF NOT EXISTS idx_publication_events_outcome
      ON publication_lifecycle_events(new_outcome, at DESC);
  `);

  db.exec(`
    UPDATE story_publish_operations
    SET publication_outcome = CASE state
      WHEN 'PUBLICATION_CONFIRMED' THEN 'PUBLICATION_CONFIRMED'
      WHEN 'PUBLICATION_UNCERTAIN' THEN 'PUBLICATION_UNCERTAIN'
      WHEN 'PUBLISH_FAILED' THEN 'PUBLISH_FAILED'
      WHEN 'ABORTED' THEN 'CANCELLED'
      WHEN 'SHARE_ARMED' THEN 'PUBLISHING'
      WHEN 'SHARE_INVOKED' THEN 'PUBLISHING'
      WHEN 'POST_SHARE_OBSERVING' THEN 'PUBLISHING'
      WHEN 'EDITOR_READY' THEN 'READY'
      WHEN 'PRE_SHARE_SNAPSHOT' THEN 'READY'
      WHEN 'FILE_SELECTED' THEN 'VALIDATING'
      WHEN 'EDITOR_LOADING' THEN 'VALIDATING'
      WHEN 'CREATE_MENU_OPEN' THEN 'VALIDATING'
      WHEN 'STORY_OPTION_VERIFIED' THEN 'VALIDATING'
      WHEN 'FILECHOOSER_ARMED' THEN 'VALIDATING'
      WHEN 'STORY_OPTION_CLICKED' THEN 'VALIDATING'
      WHEN 'SURFACE_READY' THEN 'VALIDATING'
      WHEN 'AUTH_VERIFIED' THEN 'VALIDATING'
      WHEN 'NAVIGATING_HOME' THEN 'VALIDATING'
      WHEN 'PREFLIGHT' THEN 'VALIDATING'
      WHEN 'INITIALIZING' THEN 'PENDING'
      WHEN 'AUTH_REQUIRED' THEN 'PUBLISH_FAILED'
      WHEN 'CHECKPOINT_REQUIRED' THEN 'PUBLISH_FAILED'
      WHEN 'DRY_RUN_COMPLETE' THEN 'READY'
      ELSE publication_outcome
    END
    WHERE publication_outcome IS NULL
  `);

  db.exec(`
    UPDATE publishing_history
    SET publication_outcome = CASE status
      WHEN 'STARTED' THEN 'PUBLISHING'
      WHEN 'SUCCEEDED' THEN 'PUBLICATION_CONFIRMED'
      WHEN 'FAILED' THEN 'PUBLISH_FAILED'
      WHEN 'UNCERTAIN' THEN 'PUBLICATION_UNCERTAIN'
      WHEN 'DRY_RUN' THEN 'READY'
      WHEN 'CANCELLED' THEN 'CANCELLED'
      ELSE publication_outcome
    END
    WHERE publication_outcome IS NULL
  `);

  db.exec(`
    INSERT INTO publication_lifecycle_events (
      id, operation_id, content_id, history_id, task_id, at, actor, event,
      previous_outcome, new_outcome, reason, evidence_json
    )
    SELECT
      lower(hex(randomblob(16))),
      o.id,
      o.content_id,
      h.id,
      NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      'migration-007',
      'MIGRATION_BACKFILL',
      NULL,
      o.publication_outcome,
      'Backfill canonical publication outcome during Phase B migration.',
      json_object('sourceState', o.state, 'sourceFailureCode', o.failure_code)
    FROM story_publish_operations o
    LEFT JOIN publishing_history h
      ON h.content_id = o.content_id AND h.request_id = o.id
    WHERE o.publication_outcome IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM publication_lifecycle_events e
        WHERE e.operation_id = o.id AND e.event = 'MIGRATION_BACKFILL'
      )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_story_ops_publication_outcome
      ON story_publish_operations(publication_outcome, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_history_publication_outcome
      ON publishing_history(publication_outcome, created_at DESC);
  `);
}

export const version = 7;
export const name = '007-publication-lifecycle';
