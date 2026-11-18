/**
 * Content management and publishing history schema.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_items (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      caption TEXT NOT NULL DEFAULT '',
      hashtags TEXT NOT NULL DEFAULT '[]',
      content_type TEXT NOT NULL,
      status TEXT NOT NULL,
      approval_status TEXT NOT NULL DEFAULT 'NONE',
      scheduled_at TEXT,
      schedule_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT,
      external_publish_id TEXT,
      last_error TEXT,
      idempotency_key TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_content_items_status
      ON content_items(status, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_content_items_scheduled
      ON content_items(status, scheduled_at);

    CREATE INDEX IF NOT EXISTS idx_content_items_type
      ON content_items(content_type, updated_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_content_items_idempotency
      ON content_items(idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS content_media (
      id TEXT PRIMARY KEY NOT NULL,
      content_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      media_kind TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_content_media_content
      ON content_media(content_id, sort_order ASC);

    CREATE INDEX IF NOT EXISTS idx_content_media_checksum
      ON content_media(checksum_sha256);

    CREATE TABLE IF NOT EXISTS content_approvals (
      id TEXT PRIMARY KEY NOT NULL,
      content_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_content_approvals_content
      ON content_approvals(content_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS publishing_history (
      id TEXT PRIMARY KEY NOT NULL,
      content_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      adapter TEXT NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT,
      request_id TEXT,
      container_id TEXT,
      external_publish_id TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      error_json TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_publishing_history_content
      ON publishing_history(content_id, attempt_number DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_publishing_history_idempotency
      ON publishing_history(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);
}

export const version = 2;
export const name = '002-content';
