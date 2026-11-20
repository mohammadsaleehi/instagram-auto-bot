/**
 * Publication reconciliation metadata and audit events.
 *
 * Phase A reconciliation never creates a new Share attempt. It records the
 * original uncertain state, the evidence that confirmed publication, and who
 * performed the reconciliation.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function up(db) {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(story_publish_operations)')
      .all()
      .map((row) => String(row.name)),
  );

  const addColumn = (name, definition) => {
    if (columns.has(name)) return;
    db.exec(`ALTER TABLE story_publish_operations ADD COLUMN ${name} ${definition}`);
    columns.add(name);
  };

  addColumn('reconciled_at', 'TEXT');
  addColumn('reconciled_by', 'TEXT');
  addColumn('reconciliation_reason', 'TEXT');
  addColumn('previous_state', 'TEXT');
  addColumn('previous_failure_code', 'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS story_operation_events (
      id TEXT PRIMARY KEY NOT NULL,
      operation_id TEXT NOT NULL,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      event TEXT NOT NULL,
      previous_state TEXT,
      new_state TEXT,
      reason TEXT,
      evidence_json TEXT,
      FOREIGN KEY (operation_id) REFERENCES story_publish_operations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_story_events_operation
      ON story_operation_events(operation_id, at ASC);

    CREATE INDEX IF NOT EXISTS idx_story_events_type
      ON story_operation_events(event, at DESC);
  `);
}

export const version = 6;
export const name = '006-story-reconciliation';
