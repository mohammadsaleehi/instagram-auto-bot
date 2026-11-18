import { randomUUID } from 'node:crypto';
import { IntelligenceError } from '../constants.js';

/**
 * @param {unknown} value
 * @param {unknown} [fallback]
 */
function parseJson(value, fallback = {}) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  if (typeof value !== 'string') {
    return value;
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
function mapContextRow(row) {
  return {
    id: String(row.id),
    kind: String(row.kind),
    name: String(row.name ?? ''),
    status: String(row.status ?? 'ACTIVE'),
    currentVersion: Number(row.current_version ?? 1),
    payload: parseJson(row.payload_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
function mapVersionRow(row) {
  return {
    id: String(row.id),
    contextId: String(row.context_id),
    version: Number(row.version),
    payload: parseJson(row.payload_json, {}),
    changeSummary: String(row.change_summary ?? ''),
    changedBy: String(row.changed_by ?? 'owner'),
    createdAt: String(row.created_at),
  };
}

export class ContextRepository {
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
   *   kind: string,
   *   name?: string,
   *   payload: Record<string, unknown>,
   *   changedBy?: string,
   *   changeSummary?: string,
   * }} input
   */
  create(input) {
    const now = this.nowFn().toISOString();
    const id = this.idFn();
    const versionId = this.idFn();
    const name = String(input.name ?? input.kind);
    const payloadJson = JSON.stringify(input.payload ?? {});

    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO intelligence_contexts
            (id, kind, name, status, current_version, payload_json, created_at, updated_at)
           VALUES (?, ?, ?, 'ACTIVE', 1, ?, ?, ?)`,
        )
        .run(id, input.kind, name, payloadJson, now, now);

      this.database.raw
        .prepare(
          `INSERT INTO intelligence_context_versions
            (id, context_id, version, payload_json, change_summary, changed_by, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          id,
          payloadJson,
          String(input.changeSummary ?? 'Initial version'),
          String(input.changedBy ?? 'owner'),
          now,
        );
    });

    return this.getById(id);
  }

  /**
   * @param {string} id
   * @param {{
   *   name?: string,
   *   payload: Record<string, unknown>,
   *   changedBy?: string,
   *   changeSummary?: string,
   * }} input
   */
  update(id, input) {
    const existing = this.getById(id);
    if (!existing) {
      throw new IntelligenceError(`Context not found: ${id}`, { code: 'CONTEXT_NOT_FOUND' });
    }

    const now = this.nowFn().toISOString();
    const nextVersion = existing.currentVersion + 1;
    const payloadJson = JSON.stringify(input.payload ?? {});
    const name = input.name === undefined ? existing.name : String(input.name);

    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `UPDATE intelligence_contexts
           SET name = ?, current_version = ?, payload_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(name, nextVersion, payloadJson, now, id);

      this.database.raw
        .prepare(
          `INSERT INTO intelligence_context_versions
            (id, context_id, version, payload_json, change_summary, changed_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.idFn(),
          id,
          nextVersion,
          payloadJson,
          String(input.changeSummary ?? `Updated to version ${nextVersion}`),
          String(input.changedBy ?? 'owner'),
          now,
        );
    });

    return this.getById(id);
  }

  /**
   * @param {string} id
   */
  getById(id) {
    const row = this.database.raw
      .prepare('SELECT * FROM intelligence_contexts WHERE id = ?')
      .get(id);
    return row ? mapContextRow(row) : null;
  }

  /**
   * @param {string} kind
   */
  getActiveByKind(kind) {
    const row = this.database.raw
      .prepare(
        `SELECT * FROM intelligence_contexts
         WHERE kind = ? AND status = 'ACTIVE'
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(kind);
    return row ? mapContextRow(row) : null;
  }

  /**
   * @param {{ kind?: string, limit?: number }} [options]
   */
  list(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit ?? 50), 500));
    /** @type {unknown[]} */
    const rows = options.kind
      ? this.database.raw
          .prepare(
            `SELECT * FROM intelligence_contexts
             WHERE kind = ?
             ORDER BY updated_at DESC
             LIMIT ?`,
          )
          .all(options.kind, limit)
      : this.database.raw
          .prepare(
            `SELECT * FROM intelligence_contexts
             ORDER BY updated_at DESC
             LIMIT ?`,
          )
          .all(limit);
    return rows.map((row) => mapContextRow(/** @type {Record<string, unknown>} */ (row)));
  }

  /**
   * @param {string} contextId
   */
  listVersions(contextId) {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM intelligence_context_versions
         WHERE context_id = ?
         ORDER BY version DESC`,
      )
      .all(contextId);
    return rows.map((row) => mapVersionRow(/** @type {Record<string, unknown>} */ (row)));
  }

  /**
   * @param {string} contextId
   * @param {number} version
   */
  getVersion(contextId, version) {
    const row = this.database.raw
      .prepare(
        `SELECT * FROM intelligence_context_versions
         WHERE context_id = ? AND version = ?`,
      )
      .get(contextId, version);
    return row ? mapVersionRow(row) : null;
  }

  /**
   * Snapshot references for decision records.
   */
  snapshotActiveVersionRefs() {
    const rows = this.database.raw
      .prepare(
        `SELECT id, kind, current_version, name
         FROM intelligence_contexts
         WHERE status = 'ACTIVE'`,
      )
      .all();
    return rows.map((row) => ({
      contextId: String(row.id),
      kind: String(row.kind),
      name: String(row.name ?? ''),
      version: Number(row.current_version),
    }));
  }
}
