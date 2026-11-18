import { randomUUID } from 'node:crypto';

/**
 * @param {unknown} value
 */
function redact(value) {
  const sensitive =
    /^(pass(word)?|secret|token|cookie|authorization|api.?key|openrouter.?api.?key|OPENROUTER_API_KEY)$/i;
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sensitive.test(key) ? '[REDACTED]' : redact(entry);
    }
    return out;
  }
  return value;
}

export class AuditService {
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
   *   operationId?: string | null,
   *   entityType: string,
   *   entityId?: string | null,
   *   eventType: string,
   *   summary?: string,
   *   payload?: Record<string, unknown>,
   *   actor?: string,
   * }} input
   */
  record(input) {
    const id = this.idFn();
    const now = this.nowFn().toISOString();
    this.database.raw
      .prepare(
        `INSERT INTO intelligence_audit_events
          (id, operation_id, entity_type, entity_id, event_type, summary, payload_json, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.operationId ?? null,
        input.entityType,
        input.entityId ?? null,
        input.eventType,
        input.summary ?? '',
        JSON.stringify(redact(input.payload ?? {})),
        input.actor ?? 'system',
        now,
      );
    return {
      id,
      operationId: input.operationId ?? null,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      eventType: input.eventType,
      summary: input.summary ?? '',
      payload: redact(input.payload ?? {}),
      actor: input.actor ?? 'system',
      createdAt: now,
    };
  }

  /**
   * @param {{ operationId?: string, entityType?: string, entityId?: string, limit?: number }} [options]
   */
  list(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit ?? 100), 500));
    /** @type {unknown[]} */
    let rows;
    if (options.operationId) {
      rows = this.database.raw
        .prepare(
          `SELECT * FROM intelligence_audit_events
           WHERE operation_id = ?
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(options.operationId, limit);
    } else if (options.entityType && options.entityId) {
      rows = this.database.raw
        .prepare(
          `SELECT * FROM intelligence_audit_events
           WHERE entity_type = ? AND entity_id = ?
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(options.entityType, options.entityId, limit);
    } else {
      rows = this.database.raw
        .prepare(
          `SELECT * FROM intelligence_audit_events
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(limit);
    }

    return rows.map((row) => {
      const item = /** @type {Record<string, unknown>} */ (row);
      return {
        id: String(item.id),
        operationId: item.operation_id ? String(item.operation_id) : null,
        entityType: String(item.entity_type),
        entityId: item.entity_id ? String(item.entity_id) : null,
        eventType: String(item.event_type),
        summary: String(item.summary ?? ''),
        payload: (() => {
          try {
            return JSON.parse(String(item.payload_json ?? '{}'));
          } catch {
            return {};
          }
        })(),
        actor: String(item.actor ?? 'system'),
        createdAt: String(item.created_at),
      };
    });
  }
}
