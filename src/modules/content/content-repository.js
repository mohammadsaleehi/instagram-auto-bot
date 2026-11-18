import { randomUUID } from 'node:crypto';
import { ApprovalStatus, ContentStatus } from './constants.js';

/**
 * @param {string | null | undefined} value
 * @param {unknown} [fallback]
 */
function parseJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapStoryDetailsRow(row) {
  if (!row) {
    return null;
  }
  return {
    contentId: String(row.content_id),
    storyMediaType: String(row.story_media_type),
    storyGroupId: row.story_group_id ? String(row.story_group_id) : null,
    sequenceOrder: Number(row.sequence_order ?? 0),
    storyContainerId: row.story_container_id ? String(row.story_container_id) : null,
    storyPublishedAt: row.story_published_at ? String(row.story_published_at) : null,
    storyExpiresAt: row.story_expires_at ? String(row.story_expires_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {ReadonlyArray<Record<string, unknown>>} [mediaRows]
 * @param {Record<string, unknown> | null} [storyRow]
 */
export function mapContentRow(row, mediaRows = [], storyRow = null) {
  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    caption: String(row.caption ?? ''),
    hashtags: /** @type {string[]} */ (parseJson(/** @type {string} */ (row.hashtags), [])),
    contentType: String(row.content_type),
    status: String(row.status),
    approvalStatus: String(row.approval_status ?? ApprovalStatus.NONE),
    scheduledAt: row.scheduled_at ? String(row.scheduled_at) : null,
    scheduleId: row.schedule_id ? String(row.schedule_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    publishedAt: row.published_at ? String(row.published_at) : null,
    externalPublishId: row.external_publish_id ? String(row.external_publish_id) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    metadata: /** @type {Record<string, unknown>} */ (
      parseJson(/** @type {string} */ (row.metadata_json), {})
    ),
    media: mediaRows.map(mapMediaRow),
    story: storyRow ? mapStoryDetailsRow(storyRow) : null,
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapMediaRow(row) {
  return {
    id: String(row.id),
    contentId: String(row.content_id),
    filePath: String(row.file_path),
    originalName: String(row.original_name),
    mimeType: String(row.mime_type),
    mediaKind: String(row.media_kind),
    byteSize: Number(row.byte_size),
    checksumSha256: String(row.checksum_sha256),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: String(row.created_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapApprovalRow(row) {
  return {
    id: String(row.id),
    contentId: String(row.content_id),
    action: String(row.action),
    actor: String(row.actor),
    note: String(row.note ?? ''),
    createdAt: String(row.created_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapPublishingHistoryRow(row) {
  return {
    id: String(row.id),
    contentId: String(row.content_id),
    attemptNumber: Number(row.attempt_number),
    adapter: String(row.adapter),
    status: String(row.status),
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    requestId: row.request_id ? String(row.request_id) : null,
    containerId: row.container_id ? String(row.container_id) : null,
    externalPublishId: row.external_publish_id ? String(row.external_publish_id) : null,
    dryRun: Boolean(row.dry_run),
    error: parseJson(/** @type {string} */ (row.error_json), null),
    result: parseJson(/** @type {string} */ (row.result_json), null),
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

export class ContentRepository {
  /**
   * @param {import('../../storage/database.js').Database} database
   * @param {{ nowFn?: () => Date, idFn?: () => string }} [options]
   */
  constructor(database, options = {}) {
    this.db = database;
    this._now = options.nowFn ?? (() => new Date());
    this._id = options.idFn ?? (() => randomUUID());
  }

  /**
   * @param {string} id
   */
  getById(id) {
    const row = this.db.raw
      .prepare('SELECT * FROM content_items WHERE id = ?')
      .get(id);
    if (!row) {
      return null;
    }
    const mediaRows = this.db.raw
      .prepare(
        `SELECT * FROM content_media
         WHERE content_id = ?
         ORDER BY sort_order ASC, created_at ASC`,
      )
      .all(id);
    const storyRow =
      String(/** @type {Record<string, unknown>} */ (row).content_type) === 'STORY'
        ? this.db.raw
            .prepare('SELECT * FROM story_details WHERE content_id = ?')
            .get(id)
        : null;
    return mapContentRow(
      /** @type {Record<string, unknown>} */ (row),
      /** @type {Record<string, unknown>[]} */ (mediaRows),
      storyRow ? /** @type {Record<string, unknown>} */ (storyRow) : null,
    );
  }

  /**
   * @param {string} contentId
   */
  getStoryDetails(contentId) {
    const row = this.db.raw
      .prepare('SELECT * FROM story_details WHERE content_id = ?')
      .get(contentId);
    return row ? mapStoryDetailsRow(/** @type {Record<string, unknown>} */ (row)) : null;
  }

  /**
   * Upsert Story-specific metadata. No-op fields stay unchanged when patching.
   *
   * @param {string} contentId
   * @param {{
   *   storyMediaType: string,
   *   storyGroupId?: string | null,
   *   sequenceOrder?: number,
   *   storyContainerId?: string | null,
   *   storyPublishedAt?: string | null,
   *   storyExpiresAt?: string | null,
   * }} input
   */
  upsertStoryDetails(contentId, input) {
    const now = this._now().toISOString();
    const existing = this.getStoryDetails(contentId);
    if (!existing) {
      this.db.raw
        .prepare(
          `INSERT INTO story_details (
            content_id, story_media_type, story_group_id, sequence_order,
            story_container_id, story_published_at, story_expires_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          contentId,
          input.storyMediaType,
          input.storyGroupId ?? null,
          Number(input.sequenceOrder ?? 0),
          input.storyContainerId ?? null,
          input.storyPublishedAt ?? null,
          input.storyExpiresAt ?? null,
          now,
          now,
        );
    } else {
      this.db.raw
        .prepare(
          `UPDATE story_details SET
            story_media_type = ?,
            story_group_id = ?,
            sequence_order = ?,
            story_container_id = ?,
            story_published_at = ?,
            story_expires_at = ?,
            updated_at = ?
           WHERE content_id = ?`,
        )
        .run(
          input.storyMediaType ?? existing.storyMediaType,
          input.storyGroupId !== undefined ? input.storyGroupId : existing.storyGroupId,
          input.sequenceOrder !== undefined
            ? Number(input.sequenceOrder)
            : existing.sequenceOrder,
          input.storyContainerId !== undefined
            ? input.storyContainerId
            : existing.storyContainerId,
          input.storyPublishedAt !== undefined
            ? input.storyPublishedAt
            : existing.storyPublishedAt,
          input.storyExpiresAt !== undefined
            ? input.storyExpiresAt
            : existing.storyExpiresAt,
          now,
          contentId,
        );
    }
    return this.getStoryDetails(contentId);
  }

  /**
   * List Stories ordered by group sequence then updated_at.
   *
   * @param {{
   *   status?: string | string[],
   *   groupId?: string,
   *   query?: string,
   *   limit?: number,
   *   offset?: number,
   * }} [filters]
   */
  listStories(filters = {}) {
    const clauses = ['c.content_type = ?'];
    const params = ['STORY'];

    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      clauses.push(`c.status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (filters.groupId) {
      clauses.push('s.story_group_id = ?');
      params.push(filters.groupId);
    }
    if (filters.query) {
      clauses.push('(c.title LIKE ? OR c.description LIKE ?)');
      const like = `%${filters.query}%`;
      params.push(like, like);
    }

    const limit = Math.min(Math.max(Number(filters.limit ?? 50), 1), 500);
    const offset = Math.max(Number(filters.offset ?? 0), 0);

    const rows = this.db.raw
      .prepare(
        `SELECT c.id AS id
         FROM content_items c
         LEFT JOIN story_details s ON s.content_id = c.id
         WHERE ${clauses.join(' AND ')}
         ORDER BY
           CASE WHEN s.story_group_id IS NULL THEN 1 ELSE 0 END,
           s.story_group_id ASC,
           s.sequence_order ASC,
           c.updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    return rows.map((row) =>
      this.getById(String(/** @type {Record<string, unknown>} */ (row).id)),
    );
  }

  /**
   * Stories that have passed their expiration timestamp but are still PUBLISHED.
   *
   * @param {{ now?: Date, limit?: number }} [options]
   */
  listExpiredPublishedStories(options = {}) {
    const now = (options.now ?? this._now()).toISOString();
    const limit = Math.min(Math.max(Number(options.limit ?? 100), 1), 500);
    const rows = this.db.raw
      .prepare(
        `SELECT c.id AS id
         FROM content_items c
         INNER JOIN story_details s ON s.content_id = c.id
         WHERE c.content_type = 'STORY'
           AND c.status = ?
           AND s.story_expires_at IS NOT NULL
           AND s.story_expires_at <= ?
         ORDER BY s.story_expires_at ASC
         LIMIT ?`,
      )
      .all(ContentStatus.PUBLISHED, now, limit);
    return rows.map((row) =>
      this.getById(String(/** @type {Record<string, unknown>} */ (row).id)),
    );
  }

  /**
   * @param {{
   *   status?: string | string[],
   *   contentType?: string,
   *   query?: string,
   *   limit?: number,
   *   offset?: number,
   * }} [filters]
   */
  list(filters = {}) {
    const clauses = [];
    const params = [];

    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (filters.contentType) {
      clauses.push('content_type = ?');
      params.push(filters.contentType);
    }
    if (filters.query) {
      clauses.push('(title LIKE ? OR description LIKE ? OR caption LIKE ?)');
      const like = `%${filters.query}%`;
      params.push(like, like, like);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(filters.limit ?? 50), 1), 500);
    const offset = Math.max(Number(filters.offset ?? 0), 0);

    const rows = this.db.raw
      .prepare(
        `SELECT * FROM content_items ${where}
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    return rows.map((row) =>
      this.getById(String(/** @type {Record<string, unknown>} */ (row).id)),
    );
  }

  /**
   * @param {string} contentId
   */
  listMedia(contentId) {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM content_media
         WHERE content_id = ?
         ORDER BY sort_order ASC, created_at ASC`,
      )
      .all(contentId);
    return rows.map((row) => mapMediaRow(/** @type {Record<string, unknown>} */ (row)));
  }

  /**
   * @param {{
   *   id?: string,
   *   title?: string,
   *   description?: string,
   *   caption?: string,
   *   hashtags?: string[],
   *   contentType: string,
   *   status?: string,
   *   approvalStatus?: string,
   *   scheduledAt?: string | null,
   *   scheduleId?: string | null,
   *   publishedAt?: string | null,
   *   externalPublishId?: string | null,
   *   lastError?: string | null,
   *   idempotencyKey?: string | null,
   *   metadata?: Record<string, unknown>,
   * }} input
   */
  create(input) {
    const now = this._now().toISOString();
    const id = input.id ?? this._id();

    this.db.raw
      .prepare(
        `INSERT INTO content_items (
          id, title, description, caption, hashtags, content_type, status,
          approval_status, scheduled_at, schedule_id, created_at, updated_at,
          published_at, external_publish_id, last_error, idempotency_key, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title ?? '',
        input.description ?? '',
        input.caption ?? '',
        JSON.stringify(input.hashtags ?? []),
        input.contentType,
        input.status ?? ContentStatus.DRAFT,
        input.approvalStatus ?? ApprovalStatus.NONE,
        input.scheduledAt ?? null,
        input.scheduleId ?? null,
        now,
        now,
        input.publishedAt ?? null,
        input.externalPublishId ?? null,
        input.lastError ?? null,
        input.idempotencyKey ?? null,
        JSON.stringify(input.metadata ?? {}),
      );

    return this.getById(id);
  }

  /**
   * @param {string} id
   * @param {Record<string, unknown>} patch
   */
  update(id, patch) {
    const existing = this.getById(id);
    if (!existing) {
      return null;
    }

    const now = this._now().toISOString();
    const next = {
      title: patch.title ?? existing.title,
      description: patch.description ?? existing.description,
      caption: patch.caption ?? existing.caption,
      hashtags: patch.hashtags ?? existing.hashtags,
      contentType: patch.contentType ?? existing.contentType,
      status: patch.status ?? existing.status,
      approvalStatus: patch.approvalStatus ?? existing.approvalStatus,
      scheduledAt:
        patch.scheduledAt !== undefined ? patch.scheduledAt : existing.scheduledAt,
      scheduleId: patch.scheduleId !== undefined ? patch.scheduleId : existing.scheduleId,
      publishedAt:
        patch.publishedAt !== undefined ? patch.publishedAt : existing.publishedAt,
      externalPublishId:
        patch.externalPublishId !== undefined
          ? patch.externalPublishId
          : existing.externalPublishId,
      lastError: patch.lastError !== undefined ? patch.lastError : existing.lastError,
      idempotencyKey:
        patch.idempotencyKey !== undefined
          ? patch.idempotencyKey
          : existing.idempotencyKey,
      metadata: patch.metadata ?? existing.metadata,
    };

    this.db.raw
      .prepare(
        `UPDATE content_items SET
          title = ?, description = ?, caption = ?, hashtags = ?, content_type = ?,
          status = ?, approval_status = ?, scheduled_at = ?, schedule_id = ?,
          updated_at = ?, published_at = ?, external_publish_id = ?, last_error = ?,
          idempotency_key = ?, metadata_json = ?
         WHERE id = ?`,
      )
      .run(
        next.title,
        next.description,
        next.caption,
        JSON.stringify(next.hashtags),
        next.contentType,
        next.status,
        next.approvalStatus,
        next.scheduledAt,
        next.scheduleId,
        now,
        next.publishedAt,
        next.externalPublishId,
        next.lastError,
        next.idempotencyKey,
        JSON.stringify(next.metadata),
        id,
      );

    return this.getById(id);
  }

  /**
   * @param {string} id
   */
  delete(id) {
    const result = this.db.raw.prepare('DELETE FROM content_items WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * Replace media attachments for a content item.
   *
   * @param {string} contentId
   * @param {ReadonlyArray<{
   *   id?: string,
   *   filePath: string,
   *   originalName: string,
   *   mimeType: string,
   *   mediaKind: string,
   *   byteSize: number,
   *   checksumSha256: string,
   *   width?: number | null,
   *   height?: number | null,
   *   durationMs?: number | null,
   *   sortOrder?: number,
   * }>} media
   */
  replaceMedia(contentId, media) {
    const now = this._now().toISOString();
    this.db.transaction(() => {
      this.db.raw.prepare('DELETE FROM content_media WHERE content_id = ?').run(contentId);
      const insert = this.db.raw.prepare(
        `INSERT INTO content_media (
          id, content_id, file_path, original_name, mime_type, media_kind,
          byte_size, checksum_sha256, width, height, duration_ms, sort_order, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      media.forEach((item, index) => {
        insert.run(
          item.id ?? this._id(),
          contentId,
          item.filePath,
          item.originalName,
          item.mimeType,
          item.mediaKind,
          item.byteSize,
          item.checksumSha256,
          item.width ?? null,
          item.height ?? null,
          item.durationMs ?? null,
          item.sortOrder ?? index,
          now,
        );
      });
    });
    return this.listMedia(contentId);
  }

  /**
   * @param {{
   *   contentId: string,
   *   action: string,
   *   actor: string,
   *   note?: string,
   * }} input
   */
  addApproval(input) {
    const id = this._id();
    const now = this._now().toISOString();
    this.db.raw
      .prepare(
        `INSERT INTO content_approvals (id, content_id, action, actor, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.contentId, input.action, input.actor, input.note ?? '', now);
    return this.listApprovals(input.contentId)[0];
  }

  /**
   * @param {string} contentId
   */
  listApprovals(contentId) {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM content_approvals
         WHERE content_id = ?
         ORDER BY created_at DESC`,
      )
      .all(contentId);
    return rows.map((row) => mapApprovalRow(/** @type {Record<string, unknown>} */ (row)));
  }

  /**
   * @param {{
   *   contentId: string,
   *   attemptNumber: number,
   *   adapter: string,
   *   status: string,
   *   idempotencyKey?: string | null,
   *   requestId?: string | null,
   *   containerId?: string | null,
   *   externalPublishId?: string | null,
   *   dryRun?: boolean,
   *   error?: unknown,
   *   result?: unknown,
   *   completedAt?: string | null,
   * }} input
   */
  addPublishingHistory(input) {
    const id = this._id();
    const now = this._now().toISOString();
    this.db.raw
      .prepare(
        `INSERT INTO publishing_history (
          id, content_id, attempt_number, adapter, status, idempotency_key,
          request_id, container_id, external_publish_id, dry_run, error_json,
          result_json, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.contentId,
        input.attemptNumber,
        input.adapter,
        input.status,
        input.idempotencyKey ?? null,
        input.requestId ?? null,
        input.containerId ?? null,
        input.externalPublishId ?? null,
        input.dryRun ? 1 : 0,
        input.error == null ? null : JSON.stringify(input.error),
        input.result == null ? null : JSON.stringify(input.result),
        now,
        input.completedAt ?? null,
      );
    return this.getPublishingHistoryById(id);
  }

  /**
   * @param {string} id
   */
  getPublishingHistoryById(id) {
    const row = this.db.raw.prepare('SELECT * FROM publishing_history WHERE id = ?').get(id);
    return row ? mapPublishingHistoryRow(/** @type {Record<string, unknown>} */ (row)) : null;
  }

  /**
   * @param {string} idempotencyKey
   */
  findPublishingHistoryByIdempotency(idempotencyKey) {
    const row = this.db.raw
      .prepare('SELECT * FROM publishing_history WHERE idempotency_key = ?')
      .get(idempotencyKey);
    return row ? mapPublishingHistoryRow(/** @type {Record<string, unknown>} */ (row)) : null;
  }

  /**
   * @param {string} contentId
   * @param {{ limit?: number }} [options]
   */
  listPublishingHistory(contentId, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit ?? 50), 1), 500);
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM publishing_history
         WHERE content_id = ?
         ORDER BY attempt_number DESC, created_at DESC
         LIMIT ?`,
      )
      .all(contentId, limit);
    return rows.map((row) =>
      mapPublishingHistoryRow(/** @type {Record<string, unknown>} */ (row)),
    );
  }

  /**
   * @param {string} contentId
   */
  nextAttemptNumber(contentId) {
    const row = this.db.raw
      .prepare(
        `SELECT COALESCE(MAX(attempt_number), 0) AS max_attempt
         FROM publishing_history WHERE content_id = ?`,
      )
      .get(contentId);
    return Number(/** @type {{ max_attempt: number }} */ (row).max_attempt) + 1;
  }

  /**
   * Upcoming / missed schedules for content items.
   *
   * @param {{ now?: Date, missed?: boolean, limit?: number }} [options]
   */
  listScheduled(options = {}) {
    const now = (options.now ?? this._now()).toISOString();
    const limit = Math.min(Math.max(Number(options.limit ?? 50), 1), 500);
    if (options.missed) {
      const rows = this.db.raw
        .prepare(
          `SELECT * FROM content_items
           WHERE status = ? AND scheduled_at IS NOT NULL AND scheduled_at < ?
           ORDER BY scheduled_at ASC
           LIMIT ?`,
        )
        .all(ContentStatus.SCHEDULED, now, limit);
      return rows.map((row) => this.getById(String(/** @type {Record<string, unknown>} */ (row).id)));
    }

    const rows = this.db.raw
      .prepare(
        `SELECT * FROM content_items
         WHERE status = ? AND scheduled_at IS NOT NULL AND scheduled_at >= ?
         ORDER BY scheduled_at ASC
         LIMIT ?`,
      )
      .all(ContentStatus.SCHEDULED, now, limit);
    return rows.map((row) => this.getById(String(/** @type {Record<string, unknown>} */ (row).id)));
  }
}
