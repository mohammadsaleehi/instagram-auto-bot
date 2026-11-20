import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../src/storage/database.js';
import { ContentRepository } from '../../src/modules/content/content-repository.js';
import {
  ApprovalStatus,
  ContentStatus,
  ContentType,
} from '../../src/modules/content/constants.js';

const ROOT = process.cwd();
const CLI = path.join(ROOT, 'src/cli/commands/publication-audit.js');

function runAudit(databasePath, extraArgs = []) {
  return spawnSync(process.execPath, [CLI, '--json', ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
      PUBLISHING_ADAPTER: 'mock',
      CONTENT_DRY_RUN: 'true',
      LOG_LEVEL: 'error',
    },
  });
}

function parseJson(stdout) {
  const start = stdout.indexOf('{');
  return JSON.parse(stdout.slice(start));
}

async function tempDatabasePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publication-audit-'));
  return { dir, databasePath: path.join(dir, 'bot.sqlite') };
}

describe('publication:audit CLI', () => {
  it('is read-only and returns clean JSON for an empty database', async () => {
    const { dir, databasePath } = await tempDatabasePath();
    try {
      const database = new Database({ filePath: databasePath });
      database.open();
      database.close();

      const run = runAudit(databasePath);
      expect(run.status).toBe(0);
      const result = parseJson(run.stdout);
      expect(result.ok).toBe(true);
      expect(result.summary.operations).toBe(0);
      expect(result.issues).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns non-zero for critical inconsistencies and preserves records', async () => {
    const { dir, databasePath } = await tempDatabasePath();
    try {
      const database = new Database({ filePath: databasePath });
      database.open();
      const repository = new ContentRepository(database);
      const content = repository.create({
        id: 'content-cli',
        contentType: ContentType.STORY,
        status: ContentStatus.NEEDS_ATTENTION,
        approvalStatus: ApprovalStatus.APPROVED,
      });
      database.raw
        .prepare(
          `INSERT INTO story_publish_operations (
            id, content_id, attempt_id, state, state_entered_at, surface,
            media_path, media_checksum_sha256, idempotency_key,
            share_intent_at, share_clicked_at, share_click_result,
            failure_code, retryable, evidence_json, diagnostics_dir,
            created_at, updated_at, completed_at, publication_outcome
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'op-cli',
          content.id,
          'attempt-1',
          'PUBLICATION_CONFIRMED',
          '2026-11-19T15:50:25.365Z',
          'mobile-web-portrait',
          '/tmp/js.jpg',
          'checksum-cli',
          'content-publish:cli',
          '2026-11-19T15:48:37.377Z',
          '2026-11-19T15:48:37.699Z',
          'dispatched',
          null,
          1,
          JSON.stringify({ accountHandle: 'test_account' }),
          null,
          '2026-11-19T15:48:25.337Z',
          '2026-11-19T15:50:25.365Z',
          '2026-11-19T15:50:25.365Z',
          'PUBLICATION_CONFIRMED',
        );
      repository.addPublishingHistory({
        contentId: content.id,
        attemptNumber: 1,
        adapter: 'playwright',
        status: 'UNCERTAIN',
        idempotencyKey: 'content-publish:cli',
        requestId: 'op-cli',
        dryRun: false,
        completedAt: '2026-11-19T15:50:25.578Z',
      });
      database.raw
        .prepare('UPDATE publishing_history SET publication_outcome = ? WHERE request_id = ?')
        .run('PUBLICATION_UNCERTAIN', 'op-cli');
      const before = database.raw
        .prepare(
          'SELECT id, state, share_intent_at, share_clicked_at, retryable, publication_outcome FROM story_publish_operations WHERE id = ?',
        )
        .get('op-cli');
      database.close();

      const run = runAudit(databasePath, ['--operation=op-cli']);
      expect(run.status).toBe(1);
      const result = parseJson(run.stdout);
      expect(result.ok).toBe(false);
      expect(result.summary.operations).toBe(1);
      expect(result.summary.critical).toBeGreaterThan(0);
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          'CONFIRMED_OPERATION_CONTENT_NOT_PUBLISHED',
          'SHARE_EVIDENCE_RETRYABLE',
        ]),
      );

      const afterDb = new Database({ filePath: databasePath, readOnly: true });
      afterDb.open();
      const after = afterDb.raw
        .prepare(
          'SELECT id, state, share_intent_at, share_clicked_at, retryable, publication_outcome FROM story_publish_operations WHERE id = ?',
        )
        .get('op-cli');
      afterDb.close();
      expect(after).toEqual(before);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns non-zero when the requested operation does not exist', async () => {
    const { dir, databasePath } = await tempDatabasePath();
    try {
      const database = new Database({ filePath: databasePath });
      database.open();
      database.close();
      const run = runAudit(databasePath, ['--operation=does-not-exist']);
      expect(run.status).toBe(1);
      const result = parseJson(run.stdout);
      expect(result.ok).toBe(true);
      expect(result.summary.operations).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
