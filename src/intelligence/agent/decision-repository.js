import { randomUUID } from 'node:crypto';

/**
 * @param {unknown} value
 * @param {unknown} [fallback]
 */
function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapInstruction(row) {
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    rawText: String(row.raw_text),
    status: String(row.status),
    parsed: parseJson(row.parsed_json, {}),
    ambiguities: parseJson(row.ambiguities_json, []),
    missingPrerequisites: parseJson(row.missing_prerequisites_json, []),
    requiredPermissions: parseJson(row.required_permissions_json, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapDecision(row) {
  return {
    id: String(row.id),
    instructionId: String(row.instruction_id),
    operationId: String(row.operation_id),
    status: String(row.status),
    objective: String(row.objective ?? ''),
    selectedDecision: String(row.selected_decision ?? ''),
    decisionType: String(row.decision_type ?? ''),
    reasoningSummary: String(row.reasoning_summary ?? ''),
    evidence: parseJson(row.evidence_json, []),
    historicalRefs: parseJson(row.historical_refs_json, []),
    contextVersionRefs: parseJson(row.context_version_refs_json, []),
    alternatives: parseJson(row.alternatives_json, []),
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    missingInformation: parseJson(row.missing_information_json, []),
    risks: parseJson(row.risks_json, []),
    requiredPermissions: parseJson(row.required_permissions_json, []),
    expectedOutcome: String(row.expected_outcome ?? ''),
    prerequisites: parseJson(row.prerequisites_json, []),
    facts: parseJson(row.facts_json, []),
    assumptions: parseJson(row.assumptions_json, []),
    recommendations: parseJson(row.recommendations_json, []),
    provider: row.provider ? String(row.provider) : null,
    modelRequested: row.model_requested ? String(row.model_requested) : null,
    modelUsed: row.model_used ? String(row.model_used) : null,
    promptVersion: row.prompt_version ? String(row.prompt_version) : null,
    usage: parseJson(row.usage_json, {}),
    rawResponse: parseJson(row.raw_response_json, null),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapPlan(row) {
  return {
    id: String(row.id),
    decisionId: String(row.decision_id),
    instructionId: String(row.instruction_id),
    operationId: String(row.operation_id),
    status: String(row.status),
    objective: String(row.objective ?? ''),
    selectedDecision: String(row.selected_decision ?? ''),
    riskLevel: String(row.risk_level ?? 'medium'),
    requiredPermissions: parseJson(row.required_permissions_json, []),
    approvalRequired: Boolean(row.approval_required),
    approvalStatus: String(row.approval_status ?? 'PENDING'),
    prerequisites: parseJson(row.prerequisites_json, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    rejectedAt: row.rejected_at ? String(row.rejected_at) : null,
  };
}

function mapStep(row) {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    stepIndex: Number(row.step_index),
    title: String(row.title),
    description: String(row.description ?? ''),
    toolName: row.tool_name ? String(row.tool_name) : null,
    inputs: parseJson(row.inputs_json, {}),
    expectedOutput: String(row.expected_output ?? ''),
    prerequisites: parseJson(row.prerequisites_json, []),
    status: String(row.status),
    output: parseJson(row.output_json, null),
    error: parseJson(row.error_json, null),
    taskId: row.task_id ? String(row.task_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

export class DecisionRepository {
  /**
   * @param {import('../../storage/database.js').Database} database
   * @param {{ nowFn?: () => Date, idFn?: () => string }} [options]
   */
  constructor(database, options = {}) {
    this.database = database;
    this.nowFn = options.nowFn ?? (() => new Date());
    this.idFn = options.idFn ?? (() => randomUUID());
  }

  createInstruction(input) {
    const id = this.idFn();
    const now = this.nowFn().toISOString();
    this.database.raw
      .prepare(
        `INSERT INTO intelligence_instructions
          (id, operation_id, raw_text, status, parsed_json, ambiguities_json,
           missing_prerequisites_json, required_permissions_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.operationId,
        input.rawText,
        input.status,
        JSON.stringify(input.parsed ?? {}),
        JSON.stringify(input.ambiguities ?? []),
        JSON.stringify(input.missingPrerequisites ?? []),
        JSON.stringify(input.requiredPermissions ?? []),
        now,
        now,
      );
    return this.getInstruction(id);
  }

  updateInstruction(id, patch) {
    const existing = this.getInstruction(id);
    if (!existing) return null;
    const now = this.nowFn().toISOString();
    this.database.raw
      .prepare(
        `UPDATE intelligence_instructions
         SET status = ?,
             parsed_json = ?,
             ambiguities_json = ?,
             missing_prerequisites_json = ?,
             required_permissions_json = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.status ?? existing.status,
        JSON.stringify(patch.parsed ?? existing.parsed),
        JSON.stringify(patch.ambiguities ?? existing.ambiguities),
        JSON.stringify(patch.missingPrerequisites ?? existing.missingPrerequisites),
        JSON.stringify(patch.requiredPermissions ?? existing.requiredPermissions),
        now,
        id,
      );
    return this.getInstruction(id);
  }

  getInstruction(id) {
    const row = this.database.raw
      .prepare('SELECT * FROM intelligence_instructions WHERE id = ?')
      .get(id);
    return row ? mapInstruction(row) : null;
  }

  createDecision(input) {
    const id = this.idFn();
    const now = this.nowFn().toISOString();
    this.database.raw
      .prepare(
        `INSERT INTO intelligence_decisions
          (id, instruction_id, operation_id, status, objective, selected_decision, decision_type,
           reasoning_summary, evidence_json, historical_refs_json, context_version_refs_json,
           alternatives_json, confidence, missing_information_json, risks_json,
           required_permissions_json, expected_outcome, prerequisites_json, facts_json,
           assumptions_json, recommendations_json, provider, model_requested, model_used,
           prompt_version, usage_json, raw_response_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.instructionId,
        input.operationId,
        input.status,
        input.objective ?? '',
        input.selectedDecision ?? '',
        input.decisionType ?? '',
        input.reasoningSummary ?? '',
        JSON.stringify(input.evidence ?? []),
        JSON.stringify(input.historicalRefs ?? []),
        JSON.stringify(input.contextVersionRefs ?? []),
        JSON.stringify(input.alternatives ?? []),
        input.confidence ?? null,
        JSON.stringify(input.missingInformation ?? []),
        JSON.stringify(input.risks ?? []),
        JSON.stringify(input.requiredPermissions ?? []),
        input.expectedOutcome ?? '',
        JSON.stringify(input.prerequisites ?? []),
        JSON.stringify(input.facts ?? []),
        JSON.stringify(input.assumptions ?? []),
        JSON.stringify(input.recommendations ?? []),
        input.provider ?? null,
        input.modelRequested ?? null,
        input.modelUsed ?? null,
        input.promptVersion ?? null,
        JSON.stringify(input.usage ?? {}),
        input.rawResponse === undefined ? null : JSON.stringify(input.rawResponse),
        now,
        now,
      );
    return this.getDecision(id);
  }

  getDecision(id) {
    const row = this.database.raw
      .prepare('SELECT * FROM intelligence_decisions WHERE id = ?')
      .get(id);
    return row ? mapDecision(row) : null;
  }

  listDecisions(limit = 50) {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM intelligence_decisions
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 200)));
    return rows.map((row) => mapDecision(row));
  }

  createPlan(input) {
    const id = this.idFn();
    const now = this.nowFn().toISOString();
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO intelligence_plans
            (id, decision_id, instruction_id, operation_id, status, objective, selected_decision,
             risk_level, required_permissions_json, approval_required, approval_status,
             prerequisites_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.decisionId,
          input.instructionId,
          input.operationId,
          input.status,
          input.objective ?? '',
          input.selectedDecision ?? '',
          input.riskLevel ?? 'medium',
          JSON.stringify(input.requiredPermissions ?? []),
          input.approvalRequired === false ? 0 : 1,
          input.approvalStatus ?? 'PENDING',
          JSON.stringify(input.prerequisites ?? []),
          now,
          now,
        );

      const insertStep = this.database.raw.prepare(
        `INSERT INTO intelligence_plan_steps
          (id, plan_id, step_index, title, description, tool_name, inputs_json,
           expected_output, prerequisites_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      );
      (input.steps ?? []).forEach((step, index) => {
        insertStep.run(
          this.idFn(),
          id,
          index,
          step.title,
          step.description ?? '',
          step.toolName ?? null,
          JSON.stringify(step.inputs ?? {}),
          step.expectedOutput ?? '',
          JSON.stringify(step.prerequisites ?? []),
          now,
          now,
        );
      });
    });
    return this.getPlan(id);
  }

  getPlan(id) {
    const row = this.database.raw
      .prepare('SELECT * FROM intelligence_plans WHERE id = ?')
      .get(id);
    if (!row) return null;
    const plan = mapPlan(row);
    const steps = this.database.raw
      .prepare(
        `SELECT * FROM intelligence_plan_steps
         WHERE plan_id = ?
         ORDER BY step_index ASC`,
      )
      .all(id)
      .map((step) => mapStep(step));
    return { ...plan, steps };
  }

  listPlans(limit = 50) {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM intelligence_plans
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 200)));
    return rows.map((row) => {
      const plan = mapPlan(row);
      return this.getPlan(plan.id);
    });
  }

  updatePlanStatus(id, patch) {
    const existing = this.getPlan(id);
    if (!existing) return null;
    const now = this.nowFn().toISOString();
    this.database.raw
      .prepare(
        `UPDATE intelligence_plans
         SET status = ?,
             approval_status = ?,
             approved_at = CASE WHEN ? = 'APPROVED' THEN ? ELSE approved_at END,
             rejected_at = CASE WHEN ? = 'REJECTED' THEN ? ELSE rejected_at END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.status ?? existing.status,
        patch.approvalStatus ?? existing.approvalStatus,
        patch.approvalStatus ?? existing.approvalStatus,
        now,
        patch.approvalStatus ?? existing.approvalStatus,
        now,
        now,
        id,
      );
    return this.getPlan(id);
  }

  recordUsage(input) {
    const id = this.idFn();
    const now = this.nowFn().toISOString();
    this.database.raw
      .prepare(
        `INSERT INTO intelligence_ai_usage
          (id, operation_id, instruction_id, decision_id, provider, model_requested, model_used,
           prompt_tokens, completion_tokens, total_tokens, cost, duration_ms, status,
           error_category, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.operationId ?? null,
        input.instructionId ?? null,
        input.decisionId ?? null,
        input.provider,
        input.modelRequested ?? null,
        input.modelUsed ?? null,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.totalTokens ?? null,
        input.cost ?? null,
        input.durationMs ?? null,
        input.status,
        input.errorCategory ?? null,
        now,
      );
    return id;
  }

  listUsage(limit = 50) {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM intelligence_ai_usage
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 200)));
    return rows.map((row) => ({
      id: String(row.id),
      operationId: row.operation_id ? String(row.operation_id) : null,
      instructionId: row.instruction_id ? String(row.instruction_id) : null,
      decisionId: row.decision_id ? String(row.decision_id) : null,
      provider: String(row.provider),
      modelRequested: row.model_requested ? String(row.model_requested) : null,
      modelUsed: row.model_used ? String(row.model_used) : null,
      promptTokens: row.prompt_tokens === null ? null : Number(row.prompt_tokens),
      completionTokens: row.completion_tokens === null ? null : Number(row.completion_tokens),
      totalTokens: row.total_tokens === null ? null : Number(row.total_tokens),
      cost: row.cost === null ? null : Number(row.cost),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      status: String(row.status),
      errorCategory: row.error_category ? String(row.error_category) : null,
      createdAt: String(row.created_at),
    }));
  }
}
