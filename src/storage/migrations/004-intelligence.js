/**
 * Intelligence Core schema: context, history import, AI decisions, plans, audit.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS intelligence_contexts (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      current_version INTEGER NOT NULL DEFAULT 1,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_intelligence_contexts_kind
      ON intelligence_contexts(kind, updated_at DESC);

    CREATE TABLE IF NOT EXISTS intelligence_context_versions (
      id TEXT PRIMARY KEY NOT NULL,
      context_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      change_summary TEXT NOT NULL DEFAULT '',
      changed_by TEXT NOT NULL DEFAULT 'owner',
      created_at TEXT NOT NULL,
      FOREIGN KEY (context_id) REFERENCES intelligence_contexts(id) ON DELETE CASCADE,
      UNIQUE (context_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_intelligence_context_versions_context
      ON intelligence_context_versions(context_id, version DESC);

    CREATE TABLE IF NOT EXISTS intelligence_import_batches (
      id TEXT PRIMARY KEY NOT NULL,
      source_path TEXT NOT NULL,
      source_type TEXT NOT NULL,
      status TEXT NOT NULL,
      worksheet_name TEXT,
      column_mapping_json TEXT NOT NULL DEFAULT '{}',
      preview_json TEXT NOT NULL DEFAULT '[]',
      stats_json TEXT NOT NULL DEFAULT '{}',
      error_json TEXT,
      confirmed_by TEXT,
      created_at TEXT NOT NULL,
      confirmed_at TEXT,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_intelligence_import_batches_created
      ON intelligence_import_batches(created_at DESC);

    CREATE TABLE IF NOT EXISTS intelligence_historical_decisions (
      id TEXT PRIMARY KEY NOT NULL,
      import_batch_id TEXT,
      decision_description TEXT NOT NULL DEFAULT '',
      decision_maker TEXT NOT NULL DEFAULT '',
      decision_date TEXT,
      intended_objective TEXT NOT NULL DEFAULT '',
      action_taken TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT '',
      measurement_criteria TEXT NOT NULL DEFAULT '',
      success_status TEXT,
      notes TEXT NOT NULL DEFAULT '',
      source_reference TEXT NOT NULL DEFAULT '',
      raw_json TEXT NOT NULL DEFAULT '{}',
      search_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (import_batch_id) REFERENCES intelligence_import_batches(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_intelligence_historical_search
      ON intelligence_historical_decisions(decision_date DESC);

    CREATE INDEX IF NOT EXISTS idx_intelligence_historical_batch
      ON intelligence_historical_decisions(import_batch_id);

    CREATE TABLE IF NOT EXISTS intelligence_instructions (
      id TEXT PRIMARY KEY NOT NULL,
      operation_id TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      status TEXT NOT NULL,
      parsed_json TEXT NOT NULL DEFAULT '{}',
      ambiguities_json TEXT NOT NULL DEFAULT '[]',
      missing_prerequisites_json TEXT NOT NULL DEFAULT '[]',
      required_permissions_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_instructions_operation
      ON intelligence_instructions(operation_id);

    CREATE TABLE IF NOT EXISTS intelligence_decisions (
      id TEXT PRIMARY KEY NOT NULL,
      instruction_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      selected_decision TEXT NOT NULL DEFAULT '',
      decision_type TEXT NOT NULL DEFAULT '',
      reasoning_summary TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      historical_refs_json TEXT NOT NULL DEFAULT '[]',
      context_version_refs_json TEXT NOT NULL DEFAULT '[]',
      alternatives_json TEXT NOT NULL DEFAULT '[]',
      confidence REAL,
      missing_information_json TEXT NOT NULL DEFAULT '[]',
      risks_json TEXT NOT NULL DEFAULT '[]',
      required_permissions_json TEXT NOT NULL DEFAULT '[]',
      expected_outcome TEXT NOT NULL DEFAULT '',
      prerequisites_json TEXT NOT NULL DEFAULT '[]',
      facts_json TEXT NOT NULL DEFAULT '[]',
      assumptions_json TEXT NOT NULL DEFAULT '[]',
      recommendations_json TEXT NOT NULL DEFAULT '[]',
      provider TEXT,
      model_requested TEXT,
      model_used TEXT,
      prompt_version TEXT,
      usage_json TEXT NOT NULL DEFAULT '{}',
      raw_response_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (instruction_id) REFERENCES intelligence_instructions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_intelligence_decisions_status
      ON intelligence_decisions(status, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_intelligence_decisions_instruction
      ON intelligence_decisions(instruction_id);

    CREATE TABLE IF NOT EXISTS intelligence_plans (
      id TEXT PRIMARY KEY NOT NULL,
      decision_id TEXT NOT NULL,
      instruction_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      selected_decision TEXT NOT NULL DEFAULT '',
      risk_level TEXT NOT NULL DEFAULT 'medium',
      required_permissions_json TEXT NOT NULL DEFAULT '[]',
      approval_required INTEGER NOT NULL DEFAULT 1,
      approval_status TEXT NOT NULL DEFAULT 'PENDING',
      prerequisites_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT,
      rejected_at TEXT,
      FOREIGN KEY (decision_id) REFERENCES intelligence_decisions(id) ON DELETE CASCADE,
      FOREIGN KEY (instruction_id) REFERENCES intelligence_instructions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_intelligence_plans_status
      ON intelligence_plans(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS intelligence_plan_steps (
      id TEXT PRIMARY KEY NOT NULL,
      plan_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tool_name TEXT,
      inputs_json TEXT NOT NULL DEFAULT '{}',
      expected_output TEXT NOT NULL DEFAULT '',
      prerequisites_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'PENDING',
      output_json TEXT,
      error_json TEXT,
      task_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (plan_id) REFERENCES intelligence_plans(id) ON DELETE CASCADE,
      UNIQUE (plan_id, step_index)
    );

    CREATE INDEX IF NOT EXISTS idx_intelligence_plan_steps_plan
      ON intelligence_plan_steps(plan_id, step_index ASC);

    CREATE TABLE IF NOT EXISTS intelligence_approvals (
      id TEXT PRIMARY KEY NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      actor TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      expires_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_intelligence_approvals_entity
      ON intelligence_approvals(entity_type, entity_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS intelligence_audit_events (
      id TEXT PRIMARY KEY NOT NULL,
      operation_id TEXT,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      actor TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_intelligence_audit_operation
      ON intelligence_audit_events(operation_id, created_at ASC);

    CREATE INDEX IF NOT EXISTS idx_intelligence_audit_entity
      ON intelligence_audit_events(entity_type, entity_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS intelligence_ai_usage (
      id TEXT PRIMARY KEY NOT NULL,
      operation_id TEXT,
      instruction_id TEXT,
      decision_id TEXT,
      provider TEXT NOT NULL,
      model_requested TEXT,
      model_used TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      cost REAL,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      error_category TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_intelligence_ai_usage_created
      ON intelligence_ai_usage(created_at DESC);

    CREATE TABLE IF NOT EXISTS intelligence_evaluations (
      id TEXT PRIMARY KEY NOT NULL,
      decision_id TEXT NOT NULL,
      outcome_summary TEXT NOT NULL DEFAULT '',
      success_classification TEXT,
      quality_score REAL,
      patterns_json TEXT NOT NULL DEFAULT '[]',
      repeated_mistakes_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      improvement_recommendations_json TEXT NOT NULL DEFAULT '[]',
      requires_owner_approval INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (decision_id) REFERENCES intelligence_decisions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_intelligence_evaluations_decision
      ON intelligence_evaluations(decision_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS intelligence_governance_policies (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

export const version = 4;
export const name = '004-intelligence';
