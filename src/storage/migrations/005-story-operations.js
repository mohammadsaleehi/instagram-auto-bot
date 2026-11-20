/**
 * Durable Story publishing operations.
 *
 * Phase 0 introduces the skeleton used by Phases 5+. The `share_intent_at`
 * column is the crash-safety boundary: any operation with a share intent is
 * never automatically retried.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_publish_operations (
      id TEXT PRIMARY KEY NOT NULL,
      content_id TEXT NOT NULL,
      attempt_id TEXT,
      state TEXT NOT NULL,
      state_entered_at TEXT NOT NULL,
      surface TEXT NOT NULL DEFAULT 'mobile-web-portrait',
      media_path TEXT,
      media_checksum_sha256 TEXT,
      idempotency_key TEXT,
      share_intent_at TEXT,
      share_clicked_at TEXT,
      share_click_result TEXT,
      failure_code TEXT,
      retryable INTEGER NOT NULL DEFAULT 0,
      evidence_json TEXT,
      diagnostics_dir TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_story_ops_content
      ON story_publish_operations(content_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_story_ops_state
      ON story_publish_operations(state);

    CREATE INDEX IF NOT EXISTS idx_story_ops_idempotency
      ON story_publish_operations(idempotency_key);
  `);
}

export const version = 5;
export const name = '005-story-operations';
