import { ContextKind, IntelligenceError } from '../constants.js';
import { ContextRepository } from './context-repository.js';
import { normalizeContextPayload, validateContextPayload } from './context-validator.js';

export class ContextService {
  /**
   * @param {{
   *   repository: ContextRepository,
   *   auditService?: { record: Function } | null,
   * }} options
   */
  constructor(options) {
    this.repository = options.repository;
    this.auditService = options.auditService ?? null;
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
  register(input) {
    const normalized = normalizeContextPayload(input.kind, input.payload ?? {});
    validateContextPayload(input.kind, normalized);
    const created = this.repository.create({
      kind: input.kind,
      name: input.name,
      payload: normalized,
      changedBy: input.changedBy,
      changeSummary: input.changeSummary,
    });
    this.auditService?.record?.({
      entityType: 'context',
      entityId: created.id,
      eventType: 'context.created',
      summary: `Registered ${created.kind} context`,
      payload: { kind: created.kind, version: created.currentVersion },
      actor: input.changedBy ?? 'owner',
    });
    return created;
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
    const existing = this.require(id);
    const normalized = normalizeContextPayload(existing.kind, input.payload ?? {});
    validateContextPayload(existing.kind, normalized);
    const updated = this.repository.update(id, {
      name: input.name,
      payload: normalized,
      changedBy: input.changedBy,
      changeSummary: input.changeSummary,
    });
    this.auditService?.record?.({
      entityType: 'context',
      entityId: updated.id,
      eventType: 'context.updated',
      summary: `Updated ${updated.kind} context to v${updated.currentVersion}`,
      payload: { kind: updated.kind, version: updated.currentVersion },
      actor: input.changedBy ?? 'owner',
    });
    return updated;
  }

  /**
   * @param {string} id
   */
  require(id) {
    const item = this.repository.getById(id);
    if (!item) {
      throw new IntelligenceError(`Context not found: ${id}`, { code: 'CONTEXT_NOT_FOUND' });
    }
    return item;
  }

  /**
   * @param {string} id
   */
  get(id) {
    return this.repository.getById(id);
  }

  /**
   * @param {{ kind?: string, limit?: number }} [options]
   */
  list(options = {}) {
    return this.repository.list(options);
  }

  /**
   * @param {string} kind
   */
  getActiveByKind(kind) {
    return this.repository.getActiveByKind(kind);
  }

  /**
   * Bundle currently active contexts for the Decision Engine.
   */
  getRelevantBusinessContext() {
    const kinds = [
      ContextKind.BRAND,
      ContextKind.BUSINESS,
      ContextKind.STRATEGY,
      ContextKind.AUDIENCE,
      ContextKind.PRODUCT,
      ContextKind.PERFORMANCE,
    ];
    /** @type {Record<string, unknown>} */
    const bundle = {};
    /** @type {Array<{ contextId: string, kind: string, name: string, version: number }>} */
    const versionRefs = [];

    for (const kind of kinds) {
      const active = this.repository.getActiveByKind(kind);
      if (active) {
        bundle[kind] = active.payload;
        versionRefs.push({
          contextId: active.id,
          kind: active.kind,
          name: active.name,
          version: active.currentVersion,
        });
      }
    }

    return {
      bundle,
      versionRefs,
      hasBrand: Boolean(bundle[ContextKind.BRAND]),
      hasBusiness: Boolean(bundle[ContextKind.BUSINESS]),
      hasStrategy: Boolean(bundle[ContextKind.STRATEGY]),
    };
  }

  /**
   * @param {string} contextId
   */
  listVersions(contextId) {
    this.require(contextId);
    return this.repository.listVersions(contextId);
  }
}
