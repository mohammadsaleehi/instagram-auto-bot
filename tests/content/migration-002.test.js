import { describe, expect, it } from 'vitest';
import { Database, MIGRATIONS } from '../../src/storage/database.js';

describe('migration 002 content', () => {
  it('is registered and creates content tables', () => {
    expect(MIGRATIONS.some((migration) => migration.version === 2)).toBe(true);

    const database = new Database({ filePath: ':memory:' });
    database.open();
    expect(database.getSchemaVersion()).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);

    const tables = database.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('content_items', 'content_media', 'content_approvals', 'publishing_history')
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);

    expect(tables).toEqual([
      'content_approvals',
      'content_items',
      'content_media',
      'publishing_history',
    ]);
    database.close();
  });
});
