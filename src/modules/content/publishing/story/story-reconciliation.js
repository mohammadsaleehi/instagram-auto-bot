import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  ContentStatus,
  PublishingAttemptStatus,
  STORY_TTL_MS,
} from '../../constants.js';
import { canTransition } from '../../content-state-machine.js';
import { ContentRepository } from '../../content-repository.js';
import { redactText, redactUrl } from './story-diagnostics.js';
import { StoryPublishState } from './story-states.js';

const DEFAULT_MAX_IDENTITY_DISTANCE = 32;
const DEFAULT_MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ESTIMATED_PUBLICATION_TOLERANCE_MS = 10 * 60 * 1000;

/**
 * @param {unknown} value
 * @param {unknown} fallback
 */
function parseJson(value, fallback = null) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function parseIso(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeHandle(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^@/, '');
  return trimmed || null;
}

/**
 * @param {unknown} url
 * @returns {string|null}
 */
function profileHandle(url) {
  try {
    const pathname = new URL(String(url)).pathname;
    const match = pathname.match(/^\/([A-Za-z0-9._]{1,30})\/$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} url
 * @returns {string|null}
 */
function viewerHandle(url) {
  try {
    const pathname = new URL(String(url)).pathname;
    const match = pathname.match(/^\/stories\/([A-Za-z0-9._]{1,30})(?:\/|$)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} label
 * @returns {number|null} minutes before the capture, or null
 */
export function parseRelativeMinutes(label) {
  if (typeof label !== 'string') return null;
  const text = label.trim();
  if (/^(now|just now)$/i.test(text)) return 0;
  const match = text.match(/^(\d+)\s*([smhdw])$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(value)) return null;
  if (unit === 's') return value / 60;
  if (unit === 'm') return value;
  if (unit === 'h') return value * 60;
  if (unit === 'd') return value * 1440;
  if (unit === 'w') return value * 10080;
  return null;
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function hashFile(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Reconcile a durable Story operation against independent, read-only
 * verification evidence.
 *
 * This service never creates a Share intent, never clicks Share, and never
 * creates a new operation. It only attests that an existing uncertain
 * operation is now confirmed, or rejects the reconciliation without changing
 * the operation.
 */
export class StoryReconciliationService {
  /**
   * @param {{
   *   database: import('../../../../storage/database.js').Database,
   *   repository?: ContentRepository,
   *   nowFn?: () => Date,
   *   idFn?: () => string,
   *   logger?: { info?: Function, warn?: Function } | null,
   * }} options
   */
  constructor(options) {
    if (!options?.database) {
      throw new Error('StoryReconciliationService requires a database');
    }
    this.db = options.database;
    this.repository =
      options.repository ?? new ContentRepository(options.database);
    this._now = options.nowFn ?? (() => new Date());
    this._id = options.idFn ?? (() => randomUUID());
    this.logger = options.logger ?? null;
  }

  /**
   * @param {string} operationId
   * @param {{
   *   actor?: string,
   *   reason?: string,
   *   expectedAccountHandle?: string|null,
   *   sourceMediaPath?: string|null,
   *   maxIdentityDistance?: number,
   *   maxEvidenceAgeMs?: number,
   *   dryRun?: boolean,
   *   testHooks?: { beforeCommit?: () => void },
   * }} [options]
   * @returns {Promise<{
   *   ok: boolean,
   *   classification: 'PUBLISHED'|'PUBLICATION_UNCERTAIN'|'PUBLISH_FAILED'|'NOT_PUBLISHED',
   *   operationId: string,
   *   contentId: string|null,
   *   historyId: string|null,
   *   publishedAt: string|null,
   *   previousState: string|null,
   *   previousFailureCode: string|null,
   *   alreadyReconciled: boolean,
   *   dryRun: boolean,
   *   wouldChange: boolean,
   *   reason: string,
   *   checks: Array<{name: string, ok: boolean, detail?: unknown}>,
   *   evidence: Record<string, unknown>,
   *   eventId: string|null,
   * }>}
   */
  async reconcile(operationId, options = {}) {
    const id = String(operationId ?? '').trim();
    if (!id) {
      throw new Error('A Story operation ID is required for reconciliation.');
    }

    const actor =
      String(options.actor ?? 'system:story-reconciliation').trim() ||
      'system:story-reconciliation';
    const reason =
      String(options.reason ?? 'Independent verification evidence confirms the Story.').trim() ||
      'Independent verification evidence confirms the Story.';
    const dryRun = options.dryRun === true;
    const maxIdentityDistance = Number(
      options.maxIdentityDistance ?? DEFAULT_MAX_IDENTITY_DISTANCE,
    );
    const maxEvidenceAgeMs = Number(
      options.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS,
    );
    const now = this._now();
    const nowIso = now.toISOString();
    /** @type {Array<{name: string, ok: boolean, detail?: unknown}>} */
    const checks = [];
    const check = (name, ok, detail) => {
      checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
      return Boolean(ok);
    };

    const operation = this.db.raw
      .prepare('SELECT * FROM story_publish_operations WHERE id = ?')
      .get(id);
    if (!operation) {
      return this._reject({
        classification: 'NOT_PUBLISHED',
        operationId: id,
        contentId: null,
        historyId: null,
        previousState: null,
        previousFailureCode: null,
        reason: 'operation-not-found',
        checks,
        dryRun,
        actor,
        reconciliationReason: reason,
        evidence: {},
      });
    }

    check('operation-exists', true, { id: operation.id });
    const content = this.repository.getById(String(operation.content_id));
    const mediaRows = content
      ? this.db.raw
          .prepare('SELECT * FROM content_media WHERE content_id = ? ORDER BY sort_order ASC')
          .all(content.id)
      : [];
    const histories = this.db.raw
      .prepare(
        `SELECT * FROM publishing_history
         WHERE content_id = ? AND request_id = ?
         ORDER BY created_at ASC`,
      )
      .all(String(operation.content_id), id);
    const storyDetails = content ? this.repository.getStoryDetails(content.id) : null;
    const evidence = parseJson(operation.evidence_json, {}) ?? {};
    const verification =
      evidence.independentVerification ?? evidence.verification ?? null;
    const observed = evidence.observed ?? null;

    check('content-exists', Boolean(content), content ? { id: content.id } : null);
    check(
      'content-type-story',
      content?.contentType === 'STORY',
      content?.contentType ?? null,
    );
    check(
      'approval-approved',
      content?.approvalStatus === 'APPROVED',
      content?.approvalStatus ?? null,
    );
    check('single-media-row', mediaRows.length === 1, { count: mediaRows.length });
    check(
      'media-kind-image',
      mediaRows[0]?.media_kind === 'image',
      mediaRows[0]?.media_kind ?? null,
    );
    check(
      'media-mime-allowed',
      ['image/jpeg', 'image/png'].includes(String(mediaRows[0]?.mime_type)),
      mediaRows[0]?.mime_type ?? null,
    );
    check(
      'media-checksum-matches-content',
      Boolean(
        operation.media_checksum_sha256 &&
          mediaRows[0]?.checksum_sha256 === operation.media_checksum_sha256,
      ),
      {
        operationChecksum: operation.media_checksum_sha256 ?? null,
        contentChecksum: mediaRows[0]?.checksum_sha256 ?? null,
      },
    );

    if (mediaRows[0]?.file_path) {
      const exists = await fs
        .stat(mediaRows[0].file_path)
        .then((stat) => stat.isFile())
        .catch(() => false);
      const fileHash = exists ? await hashFile(mediaRows[0].file_path).catch(() => null) : null;
      check('media-file-exists', exists, { path: mediaRows[0].file_path });
      check(
        'media-file-checksum',
        Boolean(fileHash && fileHash === operation.media_checksum_sha256),
        { fileHash },
      );
    } else {
      check('media-file-exists', false, { path: null });
      check('media-file-checksum', false, { fileHash: null });
    }

    if (options.sourceMediaPath) {
      const sourcePath = path.resolve(String(options.sourceMediaPath));
      const sourceExists = await fs
        .stat(sourcePath)
        .then((stat) => stat.isFile())
        .catch(() => false);
      const sourceHash = sourceExists ? await hashFile(sourcePath).catch(() => null) : null;
      check('source-media-exists', sourceExists, { path: sourcePath });
      check(
        'source-media-checksum',
        Boolean(sourceHash && sourceHash === operation.media_checksum_sha256),
        { sourceHash },
      );
    }

    const shareIntentMs = parseIso(operation.share_intent_at);
    const shareClickedMs = parseIso(operation.share_clicked_at);
    check('share-intent-recorded', shareIntentMs != null, {
      shareIntentAt: operation.share_intent_at ?? null,
    });
    check('share-click-recorded', shareClickedMs != null, {
      shareClickedAt: operation.share_clicked_at ?? null,
    });
    check(
      'share-click-result-dispatched',
      operation.share_click_result === 'dispatched' ||
        operation.share_click_result === 'dispatched-or-unknown',
      operation.share_click_result ?? null,
    );
    check(
      'share-click-not-before-intent',
      shareIntentMs != null &&
        shareClickedMs != null &&
        shareClickedMs >= shareIntentMs - 1000,
      { shareIntentMs, shareClickedMs },
    );

    if (!shareIntentMs && !shareClickedMs) {
      return this._reject({
        classification:
          operation.state === StoryPublishState.PUBLISH_FAILED
            ? 'PUBLISH_FAILED'
            : 'NOT_PUBLISHED',
        operationId: id,
        contentId: content?.id ?? null,
        historyId: histories[0]?.id ? String(histories[0].id) : null,
        previousState: operation.state,
        previousFailureCode: operation.failure_code,
        reason: 'no-share-intent-or-click',
        checks,
        dryRun,
        actor,
        reconciliationReason: reason,
        evidence: this._evidenceSummary({
          operation,
          content,
          mediaRows,
          verification,
          observed,
          evidence,
        }),
        existingEvent: false,
      });
    }

    if (shareIntentMs && !shareClickedMs) {
      return this._reject({
        classification: 'PUBLICATION_UNCERTAIN',
        operationId: id,
        contentId: content?.id ?? null,
        historyId: histories[0]?.id ? String(histories[0].id) : null,
        previousState: operation.state,
        previousFailureCode: operation.failure_code,
        reason: 'share-intent-without-recorded-click',
        checks,
        dryRun,
        actor,
        reconciliationReason: reason,
        evidence: this._evidenceSummary({
          operation,
          content,
          mediaRows,
          verification,
          observed,
          evidence,
        }),
      });
    }

    const accountCandidates = [
      normalizeHandle(options.expectedAccountHandle),
      normalizeHandle(evidence.accountHandle),
      profileHandle(verification?.profileUrl),
      viewerHandle(verification?.viewerUrl),
    ].filter(Boolean);
    const expectedAccount = accountCandidates[0] ?? null;
    const accountConsistent =
      accountCandidates.length > 0 &&
      accountCandidates.every(
        (handle) => handle.toLowerCase() === expectedAccount.toLowerCase(),
      );
    check('account-identity', accountConsistent, {
      expected: expectedAccount,
      candidates: accountCandidates,
    });
    check(
      'viewer-url-handle',
      Boolean(
        expectedAccount &&
          normalizeHandle(viewerHandle(verification?.viewerUrl))?.toLowerCase() ===
            expectedAccount.toLowerCase(),
      ),
      { viewerUrl: verification?.viewerUrl ? redactUrl(verification.viewerUrl) : null },
    );

    const verificationOk =
      verification &&
      verification.ok === true &&
      verification.appeared === true &&
      verification.viewerOpened === true &&
      verification.identity?.ok === true;
    check('verification-present', Boolean(verification), {
      source: evidence.independentVerification
        ? 'independentVerification'
        : evidence.verification
          ? 'verification'
          : null,
    });
    check('verification-ok', Boolean(verificationOk), verification?.reason ?? null);
    check(
      'image-identity',
      typeof verification?.identity?.distance === 'number' &&
        verification.identity.distance <= maxIdentityDistance,
      {
        distance: verification?.identity?.distance ?? null,
        maxIdentityDistance,
      },
    );
    check(
      'viewer-media',
      Number(verification?.viewerMedia?.naturalWidth) >= 720 &&
        Number(verification?.viewerMedia?.naturalHeight) >= 1280,
      {
        naturalWidth: verification?.viewerMedia?.naturalWidth ?? null,
        naturalHeight: verification?.viewerMedia?.naturalHeight ?? null,
      },
    );

    const capturedMs = parseIso(verification?.capturedAt);
    check(
      'evidence-timestamp',
      capturedMs != null &&
        shareClickedMs != null &&
        capturedMs >= shareClickedMs &&
        capturedMs - shareClickedMs <= maxEvidenceAgeMs,
      {
        capturedAt: verification?.capturedAt ?? null,
        shareClickedAt: operation.share_clicked_at ?? null,
        maxEvidenceAgeMs,
      },
    );

    const timeLabels = Array.isArray(verification?.timeLabels)
      ? verification.timeLabels.filter((label) => typeof label === 'string')
      : [];
    const relativeMinutes = timeLabels
      .map((label) => parseRelativeMinutes(label))
      .find((value) => value != null);
    const estimatedPublishedMs =
      capturedMs != null && relativeMinutes != null
        ? capturedMs - relativeMinutes * 60_000
        : null;
    check(
      'viewer-time-label',
      relativeMinutes != null &&
        estimatedPublishedMs != null &&
        shareClickedMs != null &&
        estimatedPublishedMs >=
          shareClickedMs - DEFAULT_ESTIMATED_PUBLICATION_TOLERANCE_MS &&
        estimatedPublishedMs <= capturedMs + 60_000,
      {
        timeLabels,
        relativeMinutes: relativeMinutes ?? null,
        estimatedPublishedAt:
          estimatedPublishedMs == null
            ? null
            : new Date(estimatedPublishedMs).toISOString(),
      },
    );

    const editorClosed = observed?.leftEditor === true;
    const toast = /your story was add/i.test(String(observed?.bodySnippet ?? ''));
    check('editor-closed', editorClosed, {
      url: observed?.url ? redactUrl(observed.url) : null,
      elapsedMs: observed?.elapsedMs ?? null,
    });
    check('success-toast', toast, { observed: toast });

    const history = histories[0] ?? null;
    check('history-row', histories.length === 1, { count: histories.length });
    check(
      'history-status',
      history?.status === PublishingAttemptStatus.UNCERTAIN ||
        history?.status === PublishingAttemptStatus.SUCCEEDED,
      history?.status ?? null,
    );
    const contentReconcilable =
      content?.status === ContentStatus.PUBLISHED ||
      (content && canTransition(content.status, ContentStatus.PUBLISHED));
    check('content-status', Boolean(contentReconcilable), content?.status ?? null);

    const evidenceSummary = this._evidenceSummary({
      operation,
      content,
      mediaRows,
      verification,
      observed,
      evidence,
      estimatedPublishedMs,
    });

    if (
      operation.state === StoryPublishState.PUBLICATION_CONFIRMED ||
      history?.status === PublishingAttemptStatus.SUCCEEDED
    ) {
      const consistent =
        operation.state === StoryPublishState.PUBLICATION_CONFIRMED &&
        content?.status === ContentStatus.PUBLISHED &&
        history?.status === PublishingAttemptStatus.SUCCEEDED;
      return {
        ok: consistent,
        classification: consistent ? 'PUBLISHED' : 'PUBLICATION_UNCERTAIN',
        operationId: id,
        contentId: content?.id ?? null,
        historyId: history?.id ? String(history.id) : null,
        publishedAt: content?.publishedAt ?? content?.published_at ?? operation.share_clicked_at ?? null,
        previousState: operation.previous_state ?? operation.state,
        previousFailureCode: operation.previous_failure_code ?? null,
        alreadyReconciled: consistent,
        dryRun,
        wouldChange: false,
        reason: consistent
          ? 'operation-already-reconciled'
          : 'inconsistent-confirmed-state',
        checks,
        evidence: evidenceSummary,
        eventId: null,
      };
    }

    const failedChecks = checks.filter((item) => !item.ok);
    if (failedChecks.length > 0) {
      return this._reject({
        classification:
          operation.state === StoryPublishState.PUBLISH_FAILED
            ? 'PUBLISH_FAILED'
            : 'PUBLICATION_UNCERTAIN',
        operationId: id,
        contentId: content?.id ?? null,
        historyId: history?.id ? String(history.id) : null,
        previousState: operation.state,
        previousFailureCode: operation.failure_code,
        reason: `evidence-not-sufficient:${failedChecks.map((item) => item.name).join(',')}`,
        checks,
        dryRun,
        actor,
        reconciliationReason: reason,
        evidence: evidenceSummary,
      });
    }

    if (
      operation.state !== StoryPublishState.PUBLICATION_UNCERTAIN ||
      !history ||
      history.status !== PublishingAttemptStatus.UNCERTAIN
    ) {
      return this._reject({
        classification: 'PUBLICATION_UNCERTAIN',
        operationId: id,
        contentId: content?.id ?? null,
        historyId: history?.id ? String(history.id) : null,
        previousState: operation.state,
        previousFailureCode: operation.failure_code,
        reason: 'operation-or-history-not-reconcilable',
        checks,
        dryRun,
        actor,
        reconciliationReason: reason,
        evidence: evidenceSummary,
      });
    }

    const publishedAt = new Date(shareClickedMs).toISOString();
    const expiresAt = new Date(shareClickedMs + STORY_TTL_MS).toISOString();
    const eventId = this._id();
    const lifecycleEventId = this._id();

    if (dryRun) {
      return {
        ok: true,
        classification: 'PUBLISHED',
        operationId: id,
        contentId: content.id,
        historyId: String(history.id),
        publishedAt,
        previousState: operation.state,
        previousFailureCode: operation.failure_code,
        alreadyReconciled: false,
        dryRun: true,
        wouldChange: true,
        reason: 'evidence-valid; no changes written (dry run)',
        checks,
        evidence: evidenceSummary,
        eventId: null,
      };
    }

    try {
      this.db.transaction(() => {
        const currentOperation = this.db.raw
          .prepare('SELECT * FROM story_publish_operations WHERE id = ?')
          .get(id);
        if (!currentOperation || currentOperation.state !== StoryPublishState.PUBLICATION_UNCERTAIN) {
          throw new Error('Operation state changed during reconciliation.');
        }
        const currentHistory = this.db.raw
          .prepare('SELECT * FROM publishing_history WHERE id = ?')
          .get(history.id);
        if (!currentHistory || currentHistory.status !== PublishingAttemptStatus.UNCERTAIN) {
          throw new Error('Publishing history changed during reconciliation.');
        }
        const originalResult = parseJson(currentHistory.result_json, {}) ?? {};
        const reconciliation = {
          previousStatus: 'UNCERTAIN',
          previousFailureCode: operation.failure_code ?? null,
          reconciledAt: nowIso,
          reconciledBy: actor,
          reason,
          publishedAt,
          publishedAtSource: 'share_clicked_at',
          estimatedPublishedAt:
            estimatedPublishedMs == null
              ? null
              : new Date(estimatedPublishedMs).toISOString(),
          originalShareIntentAt: operation.share_intent_at ?? null,
          originalShareClickedAt: operation.share_clicked_at ?? null,
          originalCompletedAt: operation.completed_at ?? null,
          previousStoryContainerId: storyDetails?.storyContainerId ?? null,
          evidence: evidenceSummary,
        };
        const nextResult = {
          ...originalResult,
          reconciliation,
        };

        const operationUpdate = this.db.raw
          .prepare(
            `UPDATE story_publish_operations SET
              state = ?,
              state_entered_at = ?,
              publication_outcome = ?,
              failure_code = NULL,
              retryable = 0,
              reconciled_at = ?,
              reconciled_by = ?,
              reconciliation_reason = ?,
              previous_state = ?,
              previous_failure_code = ?,
              updated_at = ?
             WHERE id = ? AND state = ?`,
          )
          .run(
            StoryPublishState.PUBLICATION_CONFIRMED,
            nowIso,
            'PUBLICATION_CONFIRMED',
            nowIso,
            actor,
            reason,
            operation.state,
            operation.failure_code,
            nowIso,
            id,
            StoryPublishState.PUBLICATION_UNCERTAIN,
          );
        if (Number(operationUpdate.changes) !== 1) {
          throw new Error('Operation was not reconciled atomically.');
        }

        const contentUpdate = this.db.raw
          .prepare(
            `UPDATE content_items SET
              status = ?,
              published_at = ?,
              external_publish_id = NULL,
              last_error = NULL,
              updated_at = ?
             WHERE id = ? AND status IN (?, ?)`,
          )
          .run(
            ContentStatus.PUBLISHED,
            publishedAt,
            nowIso,
            content.id,
            ContentStatus.NEEDS_ATTENTION,
            ContentStatus.PUBLISHING,
          );
        if (Number(contentUpdate.changes) !== 1) {
          throw new Error('Content was not reconciled atomically.');
        }

        const historyUpdate = this.db.raw
          .prepare(
            `UPDATE publishing_history SET
              status = ?,
              publication_outcome = ?,
              dry_run = 0,
              external_publish_id = NULL,
              error_json = NULL,
              result_json = ?
             WHERE id = ? AND status = ?`,
          )
          .run(
            PublishingAttemptStatus.SUCCEEDED,
            'PUBLICATION_CONFIRMED',
            JSON.stringify(nextResult),
            history.id,
            PublishingAttemptStatus.UNCERTAIN,
          );
        if (Number(historyUpdate.changes) !== 1) {
          throw new Error('Publishing history was not reconciled atomically.');
        }

        this.repository.upsertStoryDetails(content.id, {
          storyMediaType: mediaRows[0]?.media_kind === 'image' ? 'IMAGE' : 'IMAGE',
          storyGroupId: storyDetails?.storyGroupId ?? null,
          sequenceOrder: storyDetails?.sequenceOrder ?? 0,
          storyContainerId: null,
          storyPublishedAt: publishedAt,
          storyExpiresAt: expiresAt,
        });

        this.db.raw
          .prepare(
            `INSERT INTO story_operation_events (
              id, operation_id, at, actor, event, previous_state, new_state,
              reason, evidence_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            eventId,
            id,
            nowIso,
            actor,
            'RECONCILIATION_COMPLETED',
            operation.state,
            StoryPublishState.PUBLICATION_CONFIRMED,
            reason,
            JSON.stringify({
              ...evidenceSummary,
              reconciliation: {
                previousStatus: 'UNCERTAIN',
                previousFailureCode: operation.failure_code ?? null,
                originalCompletedAt: operation.completed_at ?? null,
                originalShareIntentAt: operation.share_intent_at ?? null,
                originalShareClickedAt: operation.share_clicked_at ?? null,
                newStatus: 'SUCCEEDED',
                publishedAt,
                expiresAt,
                clearedStoryContainerId: storyDetails?.storyContainerId ?? null,
              },
              checks,
            }),
          );

        const hasLifecycleEvents = this.db.raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'publication_lifecycle_events'",
          )
          .get();
        if (hasLifecycleEvents) {
          this.db.raw
            .prepare(
              `INSERT INTO publication_lifecycle_events (
                id, operation_id, content_id, history_id, task_id, at, actor,
                event, previous_outcome, new_outcome, reason, evidence_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              lifecycleEventId,
              id,
              content.id,
              String(history.id),
              null,
              nowIso,
              actor,
              'RECONCILIATION_COMPLETED',
              'PUBLICATION_UNCERTAIN',
              'PUBLICATION_CONFIRMED',
              reason,
              JSON.stringify({ ...evidenceSummary, checks }),
            );
        }

        options.testHooks?.beforeCommit?.();
      });
    } catch (error) {
      return {
        ok: false,
        classification: 'PUBLICATION_UNCERTAIN',
        operationId: id,
        contentId: content.id,
        historyId: String(history.id),
        publishedAt: null,
        previousState: operation.state,
        previousFailureCode: operation.failure_code,
        alreadyReconciled: false,
        dryRun: false,
        wouldChange: true,
        reason: `reconciliation-transaction-failed:${
          error instanceof Error ? error.message : String(error)
        }`,
        checks,
        evidence: evidenceSummary,
        eventId: null,
      };
    }

    return {
      ok: true,
      classification: 'PUBLISHED',
      operationId: id,
      contentId: content.id,
      historyId: String(history.id),
      publishedAt,
      previousState: operation.state,
      previousFailureCode: operation.failure_code,
      alreadyReconciled: false,
      dryRun: false,
      wouldChange: true,
      reason: 'publication-confirmed-by-independent-verification',
      publicationOutcome: 'PUBLICATION_CONFIRMED',
      checks,
      evidence: evidenceSummary,
      eventId,
      lifecycleEventId,
    };
  }

  /**
   * @param {{
   *   operation: Record<string, any>,
   *   content: Record<string, any>|null,
   *   mediaRows: Record<string, any>[],
   *   verification: Record<string, any>|null,
   *   observed: Record<string, any>|null,
   *   evidence: Record<string, any>,
   *   estimatedPublishedMs?: number|null,
   * }} input
   */
  _evidenceSummary(input) {
    const verification = input.verification ?? {};
    const observed = input.observed ?? {};
    return {
      accountHandle: normalizeHandle(input.evidence.accountHandle),
      media: {
        checksumSha256: input.operation.media_checksum_sha256 ?? null,
        path: input.mediaRows[0]?.file_path ?? null,
        byteSize: input.mediaRows[0]?.byte_size ?? null,
        mimeType: input.mediaRows[0]?.mime_type ?? null,
        width: input.mediaRows[0]?.width ?? null,
        height: input.mediaRows[0]?.height ?? null,
      },
      shareIntentAt: input.operation.share_intent_at ?? null,
      shareClickedAt: input.operation.share_clicked_at ?? null,
      shareClickResult: input.operation.share_click_result ?? null,
      originalState: input.operation.state ?? null,
      originalFailureCode: input.operation.failure_code ?? null,
      originalCompletedAt: input.operation.completed_at ?? null,
      verification: verification
        ? {
            ok: verification.ok ?? null,
            appeared: verification.appeared ?? null,
            viewerOpened: verification.viewerOpened ?? null,
            storyId: verification.storyId ?? null,
            profileUrl: verification.profileUrl ? redactUrl(verification.profileUrl) : null,
            viewerUrl: verification.viewerUrl ? redactUrl(verification.viewerUrl) : null,
            timeLabels: Array.isArray(verification.timeLabels)
              ? verification.timeLabels.slice(0, 5)
              : [],
            capturedAt: verification.capturedAt ?? null,
            identity: verification.identity ?? null,
            viewerMedia: verification.viewerMedia ?? null,
            reason: verification.reason ?? null,
          }
        : null,
      observed: observed
        ? {
            leftEditor: observed.leftEditor ?? null,
            url: observed.url ? redactUrl(observed.url) : null,
            elapsedMs: observed.elapsedMs ?? null,
            bodySnippet: observed.bodySnippet
              ? redactText(String(observed.bodySnippet)).slice(0, 600)
              : null,
          }
        : null,
      estimatedPublishedAt:
        input.estimatedPublishedMs == null
          ? null
          : new Date(input.estimatedPublishedMs).toISOString(),
      contentId: input.content?.id ?? null,
      contentStatus: input.content?.status ?? null,
      storyContainerId: null,
    };
  }

  /**
   * @param {{
   *   classification: 'PUBLISHED'|'PUBLICATION_UNCERTAIN'|'PUBLISH_FAILED'|'NOT_PUBLISHED',
   *   operationId: string,
   *   contentId: string|null,
   *   historyId: string|null,
   *   previousState: string|null,
   *   previousFailureCode: string|null,
   *   reason: string,
   *   checks: Array<{name: string, ok: boolean, detail?: unknown}>,
   *   dryRun: boolean,
   *   actor: string,
   *   reconciliationReason: string,
   *   evidence: Record<string, unknown>,
   *   existingEvent?: boolean,
   * }} input
   */
  _reject(input) {
    const eventId = input.dryRun ? null : this._id();
    if (!input.dryRun && input.operationId) {
      const exists = this.db.raw
        .prepare('SELECT id FROM story_publish_operations WHERE id = ?')
        .get(input.operationId);
      if (exists) {
        try {
          this.db.transaction(() => {
            this.db.raw
              .prepare(
                `INSERT INTO story_operation_events (
                  id, operation_id, at, actor, event, previous_state, new_state,
                  reason, evidence_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                eventId,
                input.operationId,
                this._now().toISOString(),
                input.actor,
                'RECONCILIATION_REJECTED',
                input.previousState,
                null,
                input.reason,
                JSON.stringify({
                  reconciliationReason: input.reconciliationReason,
                  classification: input.classification,
                  checks: input.checks,
                  evidence: input.evidence,
                }),
              );
          });
        } catch (error) {
          this.logger?.warn?.('Failed to write reconciliation rejection event', {
            operationId: input.operationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return {
      ok: false,
      classification: input.classification,
      operationId: input.operationId,
      contentId: input.contentId,
      historyId: input.historyId,
      publishedAt: null,
      previousState: input.previousState,
      previousFailureCode: input.previousFailureCode,
      alreadyReconciled: false,
      dryRun: input.dryRun,
      wouldChange: false,
      reason: input.reason,
      checks: input.checks,
      evidence: input.evidence,
      eventId,
    };
  }
}
