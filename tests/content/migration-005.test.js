import { describe, expect, it } from 'vitest';
import { Database, MIGRATIONS } from '../../src/storage/database.js';

describe('migration 005 story operations', () => {
  it('is registered and creates story_publish_operations', () => {
    expect(MIGRATIONS.some((migration) => migration.version === 5)).toBe(true);

    const database = new Database({ filePath: ':memory:' });
    database.open();
    expect(database.getSchemaVersion()).toBeGreaterThanOrEqual(5);

    const tables = database.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);

    expect(tables).toContain('story_publish_operations');
    expect(tables).toContain('publishing_history');

    const columns = database.raw
      .prepare(`PRAGMA table_info(story_publish_operations)`)
      .all()
      .map((row) => row.name);

    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'content_id',
        'attempt_id',
        'state',
        'state_entered_at',
        'surface',
        'media_path',
        'media_checksum_sha256',
        'idempotency_key',
        'share_intent_at',
        'share_clicked_at',
        'share_click_result',
        'failure_code',
        'retryable',
        'evidence_json',
        'diagnostics_dir',
        'created_at',
        'updated_at',
        'completed_at',
      ]),
    );

    const indexes = database.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'story_publish_operations'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);

    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_story_ops_content',
        'idx_story_ops_state',
        'idx_story_ops_idempotency',
      ]),
    );

    database.close();
  });
});
