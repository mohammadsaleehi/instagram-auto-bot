/**
 * Story-specific details for Instagram Stories publishing.
 * Reuses content_items / content_media / approvals / publishing_history.
 * Does not introduce Highlights schema.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_details (
      content_id TEXT PRIMARY KEY NOT NULL,
      story_media_type TEXT NOT NULL,
      story_group_id TEXT,
      sequence_order INTEGER NOT NULL DEFAULT 0,
      story_container_id TEXT,
      story_published_at TEXT,
      story_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_story_details_group
      ON story_details(story_group_id, sequence_order ASC);

    CREATE INDEX IF NOT EXISTS idx_story_details_expires
      ON story_details(story_expires_at)
      WHERE story_expires_at IS NOT NULL;
  `);
}

export const version = 3;
export const name = '003-story';
