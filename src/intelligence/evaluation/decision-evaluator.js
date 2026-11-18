import { randomUUID } from 'node:crypto';
import { IntelligenceError } from '../constants.js';

export class DecisionEvaluator {
  /**
   * @param {{
   *   database: import('../../storage/database.js').Database,
   *   decisionRepository: import('../agent/decision-repository.js').DecisionRepository,
   *   historyRepository: import('../import/history-repository.js').HistoryRepository,
   *   auditService?: import('../audit/audit-service.js').AuditService | null,
   *   nowFn?: () => Date,
   *   idFn?: () => string,
   * }} options
   */
  constructor(options) {
    this.database = options.database;
    this.decisionRepository = options.decisionRepository;
    this.historyRepository = options.historyRepository;
    this.auditService = options.auditService ?? null;
    this.nowFn = options.nowFn ?? (() => new Date());
    this.idFn = options.idFn ?? (() => randomUUID());
  }

  /**
   * Evaluate a stored decision against known outcomes / historical evidence.
   * Does not silently rewrite strategy or permissions.
   *
   * @param {string} decisionId
   * @param {{ outcomeSummary?: string }} [options]
   */
  evaluate(decisionId, options = {}) {
    const decision = this.decisionRepository.getDecision(decisionId);
    if (!decision) {
      throw new IntelligenceError(`Decision not found: ${decisionId}`, {
        code: 'DECISION_NOT_FOUND',
      });
    }

    const historical = this.historyRepository.search({ limit: 100 });
    const related = historical.filter((item) =>
      decision.historicalRefs.some((ref) => {
        const id = typeof ref === 'string' ? ref : ref?.id;
        return id && String(id) === item.id;
      }),
    );

    const successes = related.filter((item) => item.successStatus === 'success');
    const failures = related.filter((item) => item.successStatus === 'failed');

    /** @type {string[]} */
    const patterns = [];
    if (successes.length > 0) {
      patterns.push(`${successes.length} related historical decision(s) marked successful`);
    }
    if (failures.length > 0) {
      patterns.push(`${failures.length} related historical decision(s) marked failed`);
    }
    if ((decision.missingInformation ?? []).length > 0) {
      patterns.push('Decision recorded missing information at creation time');
    }

    /** @type {string[]} */
    const repeatedMistakes = [];
    const failedDescriptions = failures.map((item) => item.decisionDescription.toLowerCase());
    for (const description of failedDescriptions) {
      const repeats = historical.filter(
        (item) =>
          item.successStatus === 'failed' &&
          item.decisionDescription.toLowerCase() === description,
      );
      if (repeats.length > 1) {
        repeatedMistakes.push(`Repeated failed decision pattern: ${description}`);
      }
    }

    let successClassification = 'unknown';
    if (options.outcomeSummary) {
      const lower = options.outcomeSummary.toLowerCase();
      if (/success|improved|worked/.test(lower)) successClassification = 'successful';
      else if (/fail|worse|declin/.test(lower)) successClassification = 'unsuccessful';
    } else if (successes.length && !failures.length) {
      successClassification = 'likely_successful_based_on_history';
    } else if (failures.length && !successes.length) {
      successClassification = 'likely_unsuccessful_based_on_history';
    }

    const qualityScore =
      successClassification === 'successful' ||
      successClassification === 'likely_successful_based_on_history'
        ? 0.75
        : successClassification === 'unsuccessful' ||
            successClassification === 'likely_unsuccessful_based_on_history'
          ? 0.35
          : 0.5;

    const improvementRecommendations = [
      'Keep strategy and permission changes owner-approved only.',
      ...(decision.missingInformation ?? []).slice(0, 5).map(
        (item) => `Gather missing information before similar decisions: ${item}`,
      ),
      ...repeatedMistakes.slice(0, 3).map((item) => `Review repeated failure pattern: ${item}`),
    ];

    const id = this.idFn();
    const now = this.nowFn().toISOString();
    const evidence = related.map((item) => ({
      id: item.id,
      successStatus: item.successStatus,
      outcome: item.outcome,
    }));

    this.database.raw
      .prepare(
        `INSERT INTO intelligence_evaluations
          (id, decision_id, outcome_summary, success_classification, quality_score,
           patterns_json, repeated_mistakes_json, evidence_json,
           improvement_recommendations_json, requires_owner_approval, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id,
        decisionId,
        options.outcomeSummary ?? '',
        successClassification,
        qualityScore,
        JSON.stringify(patterns),
        JSON.stringify([...new Set(repeatedMistakes)]),
        JSON.stringify(evidence),
        JSON.stringify(improvementRecommendations),
        now,
      );

    const evaluation = {
      id,
      decisionId,
      outcomeSummary: options.outcomeSummary ?? '',
      successClassification,
      qualityScore,
      patterns,
      repeatedMistakes: [...new Set(repeatedMistakes)],
      evidence,
      improvementRecommendations,
      requiresOwnerApproval: true,
      createdAt: now,
    };

    this.auditService?.record?.({
      operationId: decision.operationId,
      entityType: 'evaluation',
      entityId: id,
      eventType: 'evaluation.created',
      summary: 'Decision evaluation recorded (no autonomous strategy mutation)',
      payload: { successClassification, qualityScore },
      actor: 'system',
    });

    return evaluation;
  }

  /**
   * @param {string} decisionId
   */
  listForDecision(decisionId) {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM intelligence_evaluations
         WHERE decision_id = ?
         ORDER BY created_at DESC`,
      )
      .all(decisionId);
    return rows.map((row) => ({
      id: String(row.id),
      decisionId: String(row.decision_id),
      outcomeSummary: String(row.outcome_summary ?? ''),
      successClassification: row.success_classification
        ? String(row.success_classification)
        : null,
      qualityScore: row.quality_score === null ? null : Number(row.quality_score),
      patterns: JSON.parse(String(row.patterns_json ?? '[]')),
      repeatedMistakes: JSON.parse(String(row.repeated_mistakes_json ?? '[]')),
      evidence: JSON.parse(String(row.evidence_json ?? '[]')),
      improvementRecommendations: JSON.parse(
        String(row.improvement_recommendations_json ?? '[]'),
      ),
      requiresOwnerApproval: Boolean(row.requires_owner_approval),
      createdAt: String(row.created_at),
    }));
  }
}
