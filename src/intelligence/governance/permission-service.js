import { randomUUID } from 'node:crypto';
import {
  ApprovalAction,
  ApprovalStatus,
  IntelligenceError,
} from '../constants.js';
import { classifyAction, createDefaultApprovalPolicy } from './approval-policy.js';

export class PermissionService {
  /**
   * @param {{
   *   database: import('../../storage/database.js').Database,
   *   policy?: ReturnType<typeof createDefaultApprovalPolicy>,
   *   nowFn?: () => Date,
   *   idFn?: () => string,
   * }} options
   */
  constructor(options) {
    this.database = options.database;
    this.policy = options.policy ?? createDefaultApprovalPolicy();
    this.nowFn = options.nowFn ?? (() => new Date());
    this.idFn = options.idFn ?? (() => randomUUID());
    this._ensurePolicyPersisted();
  }

  _ensurePolicyPersisted() {
    const existing = this.database.raw
      .prepare('SELECT id FROM intelligence_governance_policies WHERE name = ?')
      .get('default');
    if (existing) return;
    const now = this.nowFn().toISOString();
    this.database.raw
      .prepare(
        `INSERT INTO intelligence_governance_policies
          (id, name, payload_json, version, updated_at, created_at)
         VALUES (?, 'default', ?, 1, ?, ?)`,
      )
      .run(this.idFn(), JSON.stringify(this.policy), now, now);
  }

  /**
   * @param {string} action
   */
  inspect(action) {
    return classifyAction(action, this.policy);
  }

  /**
   * @param {string} action
   * @param {{ actor?: string, requireApprovalAlreadyGranted?: boolean, entityType?: string, entityId?: string }} [options]
   */
  assertAllowed(action, options = {}) {
    const verdict = this.inspect(action);
    if (!verdict.allowed) {
      throw new IntelligenceError(`Action is not permitted: ${action}`, {
        code: 'PERMISSION_DENIED',
        details: { action, verdict },
      });
    }
    if (verdict.approvalRequired) {
      if (!options.entityType || !options.entityId) {
        throw new IntelligenceError(
          `Action requires owner approval and cannot execute without an approved entity: ${action}`,
          { code: 'APPROVAL_REQUIRED', details: { action, verdict } },
        );
      }
      const approval = this.getValidApproval(options.entityType, options.entityId);
      if (!approval) {
        throw new IntelligenceError(
          `No valid owner approval for ${options.entityType}:${options.entityId}`,
          { code: 'APPROVAL_REQUIRED', details: { action, verdict } },
        );
      }
    }
    return verdict;
  }

  /**
   * Soft check used while generating plans (does not require existing approval).
   *
   * @param {string} action
   */
  canPropose(action) {
    const verdict = this.inspect(action);
    return {
      ...verdict,
      canPropose: verdict.allowed,
    };
  }

  /**
   * @param {{
   *   entityType: string,
   *   entityId: string,
   *   actor?: string,
   *   note?: string,
   *   expiresAt?: string | null,
   * }} input
   */
  approve(input) {
    return this._writeApproval({
      ...input,
      action: ApprovalAction.APPROVE,
      status: ApprovalStatus.APPROVED,
    });
  }

  /**
   * @param {{
   *   entityType: string,
   *   entityId: string,
   *   actor?: string,
   *   note?: string,
   * }} input
   */
  reject(input) {
    return this._writeApproval({
      ...input,
      action: ApprovalAction.REJECT,
      status: ApprovalStatus.REJECTED,
      expiresAt: null,
    });
  }

  /**
   * @param {string} entityType
   * @param {string} entityId
   */
  getValidApproval(entityType, entityId) {
    const row = this.database.raw
      .prepare(
        `SELECT * FROM intelligence_approvals
         WHERE entity_type = ? AND entity_id = ? AND status = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(entityType, entityId, ApprovalStatus.APPROVED);
    if (!row) return null;
    if (row.expires_at) {
      const expires = Date.parse(String(row.expires_at));
      if (Number.isFinite(expires) && expires < this.nowFn().getTime()) {
        this._writeApproval({
          entityType,
          entityId,
          action: ApprovalAction.EXPIRE,
          status: ApprovalStatus.EXPIRED,
          actor: 'system',
          note: 'Approval expired',
        });
        return null;
      }
    }
    return {
      id: String(row.id),
      entityType: String(row.entity_type),
      entityId: String(row.entity_id),
      action: String(row.action),
      status: String(row.status),
      actor: String(row.actor),
      note: String(row.note ?? ''),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      createdAt: String(row.created_at),
    };
  }

  /**
   * @param {{
   *   entityType: string,
   *   entityId: string,
   *   action: string,
   *   status: string,
   *   actor?: string,
   *   note?: string,
   *   expiresAt?: string | null,
   * }} input
   */
  _writeApproval(input) {
    const id = this.idFn();
    const now = this.nowFn().toISOString();
    this.database.raw
      .prepare(
        `INSERT INTO intelligence_approvals
          (id, entity_type, entity_id, action, status, actor, note, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.entityType,
        input.entityId,
        input.action,
        input.status,
        input.actor ?? 'owner',
        input.note ?? '',
        input.expiresAt ?? null,
        now,
      );
    return {
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      status: input.status,
      actor: input.actor ?? 'owner',
      note: input.note ?? '',
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
    };
  }
}
