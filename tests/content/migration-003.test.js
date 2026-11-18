import { describe, expect, it } from 'vitest';
import { Database, MIGRATIONS } from '../../src/storage/database.js';

describe('migration 003 story', () => {
  it('is registered and creates story_details without Highlights tables', () => {
    expect(MIGRATIONS.some((migration) => migration.version === 3)).toBe(true);

    const database = new Database({ filePath: ':memory:' });
    database.open();
    expect(database.getSchemaVersion()).toBeGreaterThanOrEqual(3);

    const tables = database.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);

    expect(tables).toContain('story_details');
    expect(tables).toContain('content_items');
    expect(tables).not.toContain('highlight_collections');
    expect(tables).not.toContain('highlight_actions');

    const columns = database.raw
      .prepare(`PRAGMA table_info(story_details)`)
      .all()
      .map((row) => row.name);

    expect(columns).toEqual(
      expect.arrayContaining([
        'content_id',
        'story_media_type',
        'story_group_id',
        'sequence_order',
        'story_container_id',
        'story_published_at',
        'story_expires_at',
      ]),
    );

    database.close();
  });
});
