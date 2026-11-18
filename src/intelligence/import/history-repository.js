import { randomUUID } from 'node:crypto';

/**
 * @param {unknown} value
 * @param {unknown} [fallback]
 */
function parseJson(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * @param {Record<string, unknown>} row
 */
function mapBatchRow(row) {
  return {
    id: String(row.id),
    sourcePath: String(row.source_path),
    sourceType: String(row.source_type),
    status: String(row.status),
    worksheetName: row.worksheet_name === null || row.worksheet_name === undefined
      ? null
      : String(row.worksheet_name),
    columnMapping: parseJson(row.column_mapping_json, {}),
    preview: parseJson(row.preview_json, []),
    stats: parseJson(row.stats_json, {}),
    error: parseJson(row.error_json, null),
    confirmedBy: row.confirmed_by === null || row.confirmed_by === undefined
      ? null
      : String(row.confirmed_by),
    createdAt: String(row.created_at),
    confirmedAt: row.confirmed_at === null || row.confirmed_at === undefined
      ? null
      : String(row.confirmed_at),
    completedAt: row.completed_at === null || row.completed_at === undefined
      ? null
      : String(row.completed_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
function mapDecisionRow(row) {
  return {
    id: String(row.id),
    importBatchId: row.import_batch_id === null || row.import_batch_id === undefined
      ? null
      : String(row.import_batch_id),
    decisionDescription: String(row.decision_description ?? ''),
    decisionMaker: String(row.decision_maker ?? ''),
    decisionDate: row.decision_date === null || row.decision_date === undefined
      ? null
      : String(row.decision_date),
    intendedObjective: String(row.intended_objective ?? ''),
    actionTaken: String(row.action_taken ?? ''),
    outcome: String(row.outcome ?? ''),
    measurementCriteria: String(row.measurement_criteria ?? ''),
    successStatus: row.success_status === null || row.success_status === undefined
      ? null
      : String(row.success_status),
    notes: String(row.notes ?? ''),
    sourceReference: String(row.source_reference ?? ''),
    raw: parseJson(row.raw_json, {}),
    searchText: String(row.search_text ?? ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * @param {Record<string, unknown>} record
 */
function buildSearchText(record) {
  return [
    record.decisionDescription,
    record.decisionMaker,
    record.intendedObjective,
    record.actionTaken,
    record.outcome,
    record.measurementCriteria,
    record.notes,
    record.sourceReference,
    record.successStatus,
  ]
    .map((part) => String(part ?? ''))
    .join(' ')
    .toLowerCase();
}

export class HistoryRepository {
  /**
   * @param {import('../../storage/database.js').Database} database
   * @param {{ nowFn?: () => Date, idFn?: () => string }} [options]
   */
  constructor(database, options = {}) {
    this.database = database;
    this.nowFn = options.nowFn ?? (() => new Date());
    this.idFn = options.idFn ?? (() => randomUUID());
  }

  /**
   * @param {{
   *   sourcePath: string,
   *   sourceType: string,
   *   worksheetName?: string | null,
   *   columnMapping?: Record<string, string>,
   *   preview?: unknown[],
   *   stats?: Record<string, unknown>,
   * }} input
   */
  createBatch(input) {
    const id = this.idFn();
    const now = this.nowFn().toISOString();
    this.database.raw
      .prepare(
        `INSERT INTO intelligence_import_batches
          (id, source_path, source_type, status, worksheet_name, column_mapping_json,
           preview_json, stats_json, created_at)
         VALUES (?, ?, ?, 'PREVIEW', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sourcePath,
        input.sourceType,
        input.worksheetName ?? null,
        JSON.stringify(input.columnMapping ?? {}),
        JSON.stringify(input.preview ?? []),
        JSON.stringify(input.stats ?? {}),
        now,
      );
    return this.getBatch(id);
  }

  /**
   * @param {string} id
   */
  getBatch(id) {
    const row = this.database.raw
      .prepare('SELECT * FROM intelligence_import_batches WHERE id = ?')
      .get(id);
    return row ? mapBatchRow(row) : null;
  }

  /**
   * @param {number} [limit=20]
   */
  listBatches(limit = 20) {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM intelligence_import_batches
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 200)));
    return rows.map((row) => mapBatchRow(/** @type {Record<string, unknown>} */ (row)));
  }

  /**
   * @param {string} batchId
   * @param {{
   *   status: string,
   *   confirmedBy?: string | null,
   *   stats?: Record<string, unknown>,
   *   error?: unknown,
   * }} patch
   */
  updateBatch(batchId, patch) {
    const now = this.nowFn().toISOString();
    const existing = this.getBatch(batchId);
    if (!existing) return null;

    this.database.raw
      .prepare(
        `UPDATE intelligence_import_batches
         SET status = ?,
             confirmed_by = COALESCE(?, confirmed_by),
             stats_json = ?,
             error_json = ?,
             confirmed_at = CASE WHEN ? = 'CONFIRMED' OR ? = 'IMPORTED' THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END,
             completed_at = CASE WHEN ? IN ('IMPORTED', 'FAILED') THEN ? ELSE completed_at END
         WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.confirmedBy ?? null,
        JSON.stringify(patch.stats ?? existing.stats ?? {}),
        patch.error === undefined ? null : JSON.stringify(patch.error),
        patch.status,
        patch.status,
        now,
        patch.status,
        now,
        batchId,
      );
    return this.getBatch(batchId);
  }

  /**
   * @param {string} batchId
   * @param {Array<Record<string, unknown>>} records
   */
  insertDecisions(batchId, records) {
    const now = this.nowFn().toISOString();
    const insert = this.database.raw.prepare(
      `INSERT INTO intelligence_historical_decisions
        (id, import_batch_id, decision_description, decision_maker, decision_date,
         intended_objective, action_taken, outcome, measurement_criteria, success_status,
         notes, source_reference, raw_json, search_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    /** @type {string[]} */
    const ids = [];
    this.database.transaction(() => {
      for (const record of records) {
        const id = this.idFn();
        ids.push(id);
        insert.run(
          id,
          batchId,
          String(record.decisionDescription ?? ''),
          String(record.decisionMaker ?? ''),
          record.decisionDate ?? null,
          String(record.intendedObjective ?? ''),
          String(record.actionTaken ?? ''),
          String(record.outcome ?? ''),
          String(record.measurementCriteria ?? ''),
          record.successStatus ?? null,
          String(record.notes ?? ''),
          String(record.sourceReference ?? ''),
          JSON.stringify(record.raw ?? record),
          buildSearchText(record),
          now,
          now,
        );
      }
    });
    return ids;
  }

  /**
   * @param {{ query?: string, limit?: number, successStatus?: string }} [options]
   */
  search(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit ?? 50), 500));
    const query = String(options.query ?? '').trim().toLowerCase();
    /** @type {unknown[]} */
    let rows;
    if (query && options.successStatus) {
      rows = this.database.raw
        .prepare(
          `SELECT * FROM intelligence_historical_decisions
           WHERE search_text LIKE ? AND success_status = ?
           ORDER BY decision_date DESC, created_at DESC
           LIMIT ?`,
        )
        .all(`%${query}%`, options.successStatus, limit);
    } else if (query) {
      rows = this.database.raw
        .prepare(
          `SELECT * FROM intelligence_historical_decisions
           WHERE search_text LIKE ?
           ORDER BY decision_date DESC, created_at DESC
           LIMIT ?`,
        )
        .all(`%${query}%`, limit);
    } else if (options.successStatus) {
      rows = this.database.raw
        .prepare(
          `SELECT * FROM intelligence_historical_decisions
           WHERE success_status = ?
           ORDER BY decision_date DESC, created_at DESC
           LIMIT ?`,
        )
        .all(options.successStatus, limit);
    } else {
      rows = this.database.raw
        .prepare(
          `SELECT * FROM intelligence_historical_decisions
           ORDER BY decision_date DESC, created_at DESC
           LIMIT ?`,
        )
        .all(limit);
    }
    return rows.map((row) => mapDecisionRow(/** @type {Record<string, unknown>} */ (row)));
  }

  /**
   * @param {string} id
   */
  getDecision(id) {
    const row = this.database.raw
      .prepare('SELECT * FROM intelligence_historical_decisions WHERE id = ?')
      .get(id);
    return row ? mapDecisionRow(row) : null;
  }
}
