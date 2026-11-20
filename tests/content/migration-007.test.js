import { describe, expect, it } from 'vitest';
import { Database, MIGRATIONS } from '../../src/storage/database.js';
import { ContentRepository } from '../../src/modules/content/content-repository.js';
import {
  ApprovalStatus,
  ContentStatus,
  ContentType,
} from '../../src/modules/content/constants.js';
import { up as up007 } from '../../src/storage/migrations/007-publication-lifecycle.js';

describe('migration 007 canonical publication lifecycle', () => {
  it('is registered, backfills existing records, and records a backfill event', () => {
    expect(MIGRATIONS.some((migration) => migration.version === 7)).toBe(true);

    const database = new Database({ filePath: ':memory:' });
    database.open();
    expect(database.getSchemaVersion()).toBeGreaterThanOrEqual(7);

    const repository = new ContentRepository(database, {
      nowFn: () => new Date('2026-11-20T00:00:00.000Z'),
    });
    const content = repository.create({
      id: 'content-migration-7',
      contentType: ContentType.STORY,
      status: ContentStatus.PUBLISHED,
      approvalStatus: ApprovalStatus.APPROVED,
    });
    database.raw
      .prepare(
        `INSERT INTO story_publish_operations (
          id, content_id, attempt_id, state, state_entered_at, surface,
          media_path, media_checksum_sha256, idempotency_key,
          share_intent_at, share_clicked_at, share_click_result,
          failure_code, retryable, evidence_json, diagnostics_dir,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'op-migration-7',
        content.id,
        'attempt-1',
        'PUBLICATION_CONFIRMED',
        '2026-11-19T15:50:25.365Z',
        'mobile-web-portrait',
        '/tmp/js.jpg',
        'abc123',
        'content-publish:migration',
        '2026-11-19T15:48:37.377Z',
        '2026-11-19T15:48:37.699Z',
        'dispatched',
        null,
        0,
        JSON.stringify({ accountHandle: 'test_account' }),
        null,
        '2026-11-19T15:48:25.337Z',
        '2026-11-19T15:50:25.365Z',
        '2026-11-19T15:50:25.365Z',
      );
    repository.addPublishingHistory({
      contentId: content.id,
      attemptNumber: 1,
      adapter: 'playwright',
      status: 'SUCCEEDED',
      idempotencyKey: 'content-publish:migration',
      requestId: 'op-migration-7',
      dryRun: false,
      completedAt: '2026-11-19T15:50:25.578Z',
    });

    // Force the canonical columns back to NULL to exercise the backfill.
    database.raw
      .prepare('UPDATE story_publish_operations SET publication_outcome = NULL WHERE id = ?')
      .run('op-migration-7');
    database.raw
      .prepare('UPDATE publishing_history SET publication_outcome = NULL WHERE request_id = ?')
      .run('op-migration-7');

    up007(database.raw);

    const operation = database.raw
      .prepare('SELECT publication_outcome FROM story_publish_operations WHERE id = ?')
      .get('op-migration-7');
    expect(operation.publication_outcome).toBe('PUBLICATION_CONFIRMED');

    const history = database.raw
      .prepare('SELECT publication_outcome FROM publishing_history WHERE request_id = ?')
      .get('op-migration-7');
    expect(history.publication_outcome).toBe('PUBLICATION_CONFIRMED');

    const events = database.raw
      .prepare(
        "SELECT * FROM publication_lifecycle_events WHERE operation_id = ? AND event = 'MIGRATION_BACKFILL'",
      )
      .all('op-migration-7');
    expect(events).toHaveLength(1);
    expect(events[0].new_outcome).toBe('PUBLICATION_CONFIRMED');
    expect(events[0].actor).toBe('migration-007');

    // Re-running the migration must not duplicate the backfill event.
    up007(database.raw);
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM publication_lifecycle_events WHERE operation_id = ? AND event = 'MIGRATION_BACKFILL'",
        )
        .get('op-migration-7').n,
    ).toBe(1);

    const columns = database.raw
      .prepare('PRAGMA table_info(story_publish_operations)')
      .all()
      .map((row) => row.name);
    expect(columns).toContain('publication_outcome');
    expect(
      database.raw
        .prepare('PRAGMA table_info(publishing_history)')
        .all()
        .map((row) => row.name),
    ).toContain('publication_outcome');

    const indexes = database.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'publication_lifecycle_events'",
      )
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_publication_events_operation',
        'idx_publication_events_content',
        'idx_publication_events_outcome',
      ]),
    );

    database.close();
  });
});
