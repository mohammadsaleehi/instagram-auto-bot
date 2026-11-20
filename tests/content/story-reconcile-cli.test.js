import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const CLI = path.join(ROOT, 'src/cli/commands/story-reconcile.js');
const OPERATION_ID = 'op-cli-reconcile';
const CONTENT_ID = 'content-cli-reconcile';
const SHARE_INTENT_AT = '2026-11-19T15:48:37.377Z';
const SHARE_CLICKED_AT = '2026-11-19T15:48:37.699Z';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function seed(databasePath, mediaPath) {
  const database = new Database({ filePath: databasePath });
  database.open();
  const repository = new ContentRepository(database);
  const content = repository.create({
    id: CONTENT_ID,
    title: 'CLI reconcile Story',
    contentType: ContentType.STORY,
    status: ContentStatus.NEEDS_ATTENTION,
    approvalStatus: ApprovalStatus.APPROVED,
    idempotencyKey: 'content-publish:cli-reconcile',
  });
  const mediaBytes = await fs.readFile(mediaPath);
  const checksum = sha256(mediaBytes);
  repository.replaceMedia(content.id, [
    {
      filePath: mediaPath,
      originalName: 'js.jpg',
      mimeType: 'image/jpeg',
      mediaKind: 'image',
      byteSize: mediaBytes.length,
      checksumSha256: checksum,
      width: 1366,
      height: 768,
    },
  ]);
  repository.addPublishingHistory({
    contentId: content.id,
    attemptNumber: 1,
    adapter: 'playwright',
    status: 'UNCERTAIN',
    idempotencyKey: 'content-publish:cli-reconcile',
    requestId: OPERATION_ID,
    dryRun: false,
    error: { message: 'uncertain' },
    result: { message: 'uncertain' },
    completedAt: '2026-11-19T15:50:25.365Z',
  });
  const verification = {
    ok: true,
    appeared: true,
    viewerOpened: true,
    storyId: null,
    storyIds: [],
    timeLabels: ['5m'],
    identity: { ok: true, distance: 5.23, cover: 5.23, contain: 14.61 },
    profileUrl: 'https://www.instagram.com/test_account/',
    viewerUrl: 'https://www.instagram.com/stories/test_account/',
    viewerMedia: {
      tag: 'IMG',
      box: { x: 0, y: 0, width: 390, height: 844 },
      naturalWidth: 1170,
      naturalHeight: 2532,
      srcHost: 'scontent.example',
      usedDataUrl: false,
    },
    capturedAt: '2026-11-19T15:53:37.699Z',
  };
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
      OPERATION_ID,
      content.id,
      'attempt-1',
      'PUBLICATION_UNCERTAIN',
      '2026-11-19T15:50:25.365Z',
      'mobile-web-portrait',
      mediaPath,
      checksum,
      'content-publish:cli-reconcile',
      SHARE_INTENT_AT,
      SHARE_CLICKED_AT,
      'dispatched',
      'SHARE_NOT_CONFIRMED',
      0,
      JSON.stringify({
        accountHandle: 'test_account',
        observed: {
          leftEditor: true,
          url: 'https://www.instagram.com/',
          elapsedMs: 11_014,
          bodySnippet: 'Your story was added to Instagram',
        },
        verification: { ok: false, reason: 'automated-verifier-false-negative' },
        independentVerification: verification,
      }),
      null,
      '2026-11-19T15:48:25.337Z',
      '2026-11-19T15:50:25.365Z',
      '2026-11-19T15:50:25.365Z',
    );
  database.close();
}

async function readState(databasePath) {
  const database = new Database({ filePath: databasePath, readOnly: true });
  database.open();
  const operation = database.raw
    .prepare('SELECT state, publication_outcome, share_intent_at, share_clicked_at FROM story_publish_operations WHERE id = ?')
    .get(OPERATION_ID);
  const content = database.raw
    .prepare('SELECT status, published_at FROM content_items WHERE id = ?')
    .get(CONTENT_ID);
  const history = database.raw
    .prepare('SELECT status, publication_outcome FROM publishing_history WHERE request_id = ?')
    .get(OPERATION_ID);
  database.close();
  return { operation, content, history };
}

function runReconcile(databasePath, extraArgs) {
  return spawnSync(
    process.execPath,
    [
      CLI,
      `--operation=${OPERATION_ID}`,
      '--account=test_account',
      `--media=${databasePath.replace(/bot\.sqlite$/, 'js.jpg')}`,
      '--json',
      ...extraArgs,
    ],
    {
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
    },
  );
}

function parseJson(stdout) {
  return JSON.parse(stdout.slice(stdout.indexOf('{')));
}

describe('story:reconcile CLI', () => {
  it('is dry-run by default and writes only with --confirm', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-reconcile-cli-'));
    const databasePath = path.join(dir, 'bot.sqlite');
    const mediaPath = path.join(dir, 'js.jpg');
    try {
      await fs.writeFile(mediaPath, Buffer.from('cli-reconcile-media-bytes'));
      await seed(databasePath, mediaPath);
      const before = await readState(databasePath);
      expect(before.operation.state).toBe('PUBLICATION_UNCERTAIN');

      const dry = runReconcile(databasePath, []);
      expect(dry.status).toBe(0);
      const dryResult = parseJson(dry.stdout);
      expect(dryResult.ok).toBe(true);
      expect(dryResult.dryRun).toBe(true);
      expect(dryResult.confirmed).toBe(false);
      expect(dryResult.classification).toBe('PUBLISHED');
      expect(dryResult.wouldChange).toBe(true);
      const afterDry = await readState(databasePath);
      expect(afterDry).toEqual(before);

      const confirm = runReconcile(databasePath, [
        '--confirm',
        '--actor=cli-test',
        '--reason=CLI test verified reconciliation',
      ]);
      expect(confirm.status).toBe(0);
      const confirmedResult = parseJson(confirm.stdout);
      expect(confirmedResult.ok).toBe(true);
      expect(confirmedResult.dryRun).toBe(false);
      expect(confirmedResult.confirmed).toBe(true);
      expect(confirmedResult.classification).toBe('PUBLISHED');

      const afterConfirm = await readState(databasePath);
      expect(afterConfirm.operation.state).toBe('PUBLICATION_CONFIRMED');
      expect(afterConfirm.operation.publication_outcome).toBe(
        'PUBLICATION_CONFIRMED',
      );
      expect(afterConfirm.operation.share_intent_at).toBe(SHARE_INTENT_AT);
      expect(afterConfirm.operation.share_clicked_at).toBe(SHARE_CLICKED_AT);
      expect(afterConfirm.content.status).toBe('PUBLISHED');
      expect(afterConfirm.history.status).toBe('SUCCEEDED');
      expect(afterConfirm.history.publication_outcome).toBe(
        'PUBLICATION_CONFIRMED',
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
