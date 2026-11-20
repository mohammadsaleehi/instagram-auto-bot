import { describe, expect, it } from 'vitest';
import { Database, MIGRATIONS } from '../../src/storage/database.js';
import { up as up006 } from '../../src/storage/migrations/006-story-operation-events.js';

describe('migration 006 story reconciliation events', () => {
  it('is registered and adds reconciliation metadata and the audit event table', () => {
    expect(MIGRATIONS.some((migration) => migration.version === 6)).toBe(true);

    const database = new Database({ filePath: ':memory:' });
    database.open();
    expect(database.getSchemaVersion()).toBeGreaterThanOrEqual(6);

    const columns = database.raw
      .prepare('PRAGMA table_info(story_publish_operations)')
      .all()
      .map((row) => row.name);

    expect(columns).toEqual(
      expect.arrayContaining([
        'reconciled_at',
        'reconciled_by',
        'reconciliation_reason',
        'previous_state',
        'previous_failure_code',
      ]),
    );

    const tables = database.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(tables).toContain('story_operation_events');

    const eventColumns = database.raw
      .prepare('PRAGMA table_info(story_operation_events)')
      .all()
      .map((row) => row.name);
    expect(eventColumns).toEqual(
      expect.arrayContaining([
        'id',
        'operation_id',
        'at',
        'actor',
        'event',
        'previous_state',
        'new_state',
        'reason',
        'evidence_json',
      ]),
    );

    const indexes = database.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'story_operation_events'",
      )
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_story_events_operation', 'idx_story_events_type']),
    );

    // Migration helpers are safe to re-run.
    up006(database.raw);
    up006(database.raw);
    expect(
      database.raw
        .prepare('PRAGMA table_info(story_publish_operations)')
        .all()
        .filter((row) => row.name === 'reconciled_at'),
    ).toHaveLength(1);

    database.close();
  });
});
