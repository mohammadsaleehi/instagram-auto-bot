import {
  DEFAULT_PROMPT_VERSION,
  DecisionStatus,
  IntelligenceError,
  InstructionStatus,
  PermissionAction,
} from '../constants.js';
import { runToolLoop } from './tool-loop.js';

const DECISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'decisionType',
    'objective',
    'selectedDecision',
    'reasoningSummary',
    'confidence',
    'evidence',
    'missingInformation',
    'requiredPermissions',
    'expectedOutcome',
  ],
  properties: {
    decisionType: { type: 'string' },
    objective: { type: 'string' },
    selectedDecision: { type: 'string' },
    evidence: { type: 'array' },
    historicalRefs: { type: 'array' },
    contextRefs: { type: 'array' },
    reasoningSummary: { type: 'string' },
    alternativesConsidered: { type: 'array' },
    confidence: { type: 'number' },
    risks: { type: 'array' },
    missingInformation: { type: 'array' },
    requiredPermissions: { type: 'array' },
    expectedOutcome: { type: 'string' },
    prerequisites: { type: 'array' },
    facts: { type: 'array' },
    assumptions: { type: 'array' },
    recommendations: { type: 'array' },
    proposedPlanSteps: { type: 'array' },
  },
};

export class DecisionEngine {
  /**
   * @param {{
   *   provider: { complete: Function, isMock?: boolean, name: string },
   *   toolRegistry: import('./tool-registry.js').ToolRegistry,
   *   permissionService: import('../governance/permission-service.js').PermissionService,
   *   contextService: import('../context/context-service.js').ContextService,
   *   importService: import('../import/import-service.js').ImportService,
   *   decisionRepository: import('./decision-repository.js').DecisionRepository,
   *   auditService?: import('../audit/audit-service.js').AuditService | null,
   *   maxToolIterations?: number,
   *   promptVersion?: string,
   * }} options
   */
  constructor(options) {
    this.provider = options.provider;
    this.toolRegistry = options.toolRegistry;
    this.permissionService = options.permissionService;
    this.contextService = options.contextService;
    this.importService = options.importService;
    this.decisionRepository = options.decisionRepository;
    this.auditService = options.auditService ?? null;
    this.maxToolIterations = options.maxToolIterations ?? 8;
    this.promptVersion = options.promptVersion ?? DEFAULT_PROMPT_VERSION;
  }

  /**
   * @param {{
   *   instructionRecord: any,
   *   parsed: any,
   *   operationId: string,
   *   signal?: AbortSignal,
   * }} input
   */
  async decide(input) {
    this.permissionService.assertAllowed(PermissionAction.ANALYZE, { actor: 'system' });

    const context = this.contextService.getRelevantBusinessContext();
    const historical = this.importService.search({
      query: [input.parsed.target, 'performance', 'story', 'content']
        .filter(Boolean)
        .join(' '),
      limit: 25,
    });

    this.decisionRepository.updateInstruction(input.instructionRecord.id, {
      status: InstructionStatus.ANALYZING,
    });

    const systemPrompt = [
      'You are the operational Decision Engine for an Instagram business automation agent.',
      'You are an executor within owner-defined strategy and constraints, not an independent strategist.',
      'Never invent business statistics, historical records, performance metrics, or evidence.',
      'Distinguish facts, assumptions, and recommendations explicitly.',
      'Do not confuse correlation with causation.',
      'If information is insufficient, say so and avoid unsupported conclusions.',
      'Do not propose unauthorized discounts, price changes, budget changes, or strategy rewrites.',
      'Return a single JSON object matching the required decision schema.',
      this.provider.isMock
        ? 'NOTE: This response is produced by a MockProvider for testing and is not real AI output.'
        : 'Provider: OpenRouter gateway.',
    ].join('\n');

    const userPrompt = {
      instruction: input.parsed,
      contextVersionRefs: context.versionRefs,
      contextBundle: context.bundle,
      historicalDecisionCount: historical.length,
      historicalDecisions: historical.slice(0, 25).map((item) => ({
        id: item.id,
        decisionDescription: item.decisionDescription,
        decisionDate: item.decisionDate,
        actionTaken: item.actionTaken,
        outcome: item.outcome,
        successStatus: item.successStatus,
        intendedObjective: item.intendedObjective,
      })),
      rules: {
        noFabrication: true,
        ownerIsAuthority: true,
        phase1NoPublishing: true,
      },
    };

    let loopResult;
    try {
      loopResult = await runToolLoop({
        provider: this.provider,
        toolRegistry: this.toolRegistry,
        permissionService: this.permissionService,
        auditService: this.auditService,
        maxIterations: this.maxToolIterations,
        operationId: input.operationId,
        signal: input.signal,
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'intelligence_decision',
            strict: true,
            schema: DECISION_JSON_SCHEMA,
          },
        },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(userPrompt) },
        ],
      });
    } catch (error) {
      this.decisionRepository.recordUsage({
        operationId: input.operationId,
        instructionId: input.instructionRecord.id,
        provider: this.provider.name,
        status: 'failed',
        errorCategory: error instanceof IntelligenceError ? error.code : 'PROVIDER_FAILURE',
      });
      this.decisionRepository.updateInstruction(input.instructionRecord.id, {
        status: InstructionStatus.FAILED,
      });
      throw error;
    }

    const validated = this._validateDecisionPayload(loopResult.result.content, {
      contextVersionRefs: context.versionRefs,
      historical,
      providerResult: loopResult.result,
    });

    const decision = this.decisionRepository.createDecision({
      instructionId: input.instructionRecord.id,
      operationId: input.operationId,
      status: DecisionStatus.PENDING_APPROVAL,
      objective: validated.objective,
      selectedDecision: validated.selectedDecision,
      decisionType: validated.decisionType,
      reasoningSummary: validated.reasoningSummary,
      evidence: validated.evidence,
      historicalRefs: validated.historicalRefs,
      contextVersionRefs: validated.contextRefs,
      alternatives: validated.alternativesConsidered,
      confidence: validated.confidence,
      missingInformation: validated.missingInformation,
      risks: validated.risks,
      requiredPermissions: validated.requiredPermissions,
      expectedOutcome: validated.expectedOutcome,
      prerequisites: validated.prerequisites,
      facts: validated.facts,
      assumptions: validated.assumptions,
      recommendations: validated.recommendations,
      provider: loopResult.result.provider,
      modelRequested: loopResult.result.modelRequested,
      modelUsed: loopResult.result.modelUsed,
      promptVersion: this.promptVersion,
      usage: loopResult.result.usage,
      rawResponse: {
        content: loopResult.result.content,
        isMock: Boolean(loopResult.result.isMock),
        toolTrace: loopResult.toolTrace,
        proposedPlanSteps: validated.proposedPlanSteps,
      },
    });

    this.decisionRepository.recordUsage({
      operationId: input.operationId,
      instructionId: input.instructionRecord.id,
      decisionId: decision.id,
      provider: loopResult.result.provider,
      modelRequested: loopResult.result.modelRequested,
      modelUsed: loopResult.result.modelUsed,
      promptTokens: loopResult.result.usage?.promptTokens ?? null,
      completionTokens: loopResult.result.usage?.completionTokens ?? null,
      totalTokens: loopResult.result.usage?.totalTokens ?? null,
      cost: loopResult.result.usage?.cost ?? null,
      durationMs: loopResult.result.durationMs ?? null,
      status: 'succeeded',
    });

    this.decisionRepository.updateInstruction(input.instructionRecord.id, {
      status: InstructionStatus.DECIDED,
    });

    this.auditService?.record?.({
      operationId: input.operationId,
      entityType: 'decision',
      entityId: decision.id,
      eventType: 'decision.created',
      summary: 'Operational decision recorded',
      payload: {
        confidence: decision.confidence,
        provider: decision.provider,
        modelUsed: decision.modelUsed,
        isMock: Boolean(loopResult.result.isMock),
      },
      actor: 'system',
    });

    return {
      decision,
      proposedPlanSteps: validated.proposedPlanSteps,
      toolTrace: loopResult.toolTrace,
      isMock: Boolean(loopResult.result.isMock),
    };
  }

  /**
   * @param {string | null} content
   * @param {{ contextVersionRefs: any[], historical: any[], providerResult: any }} helpers
   */
  _validateDecisionPayload(content, helpers) {
    if (!content || !String(content).trim()) {
      throw new IntelligenceError('AI provider returned an empty decision payload', {
        code: 'AI_INVALID_OUTPUT',
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(extractJsonObject(String(content)));
    } catch (error) {
      throw new IntelligenceError('AI provider returned malformed JSON decision output', {
        code: 'AI_INVALID_OUTPUT',
        cause: error,
      });
    }

    for (const key of DECISION_JSON_SCHEMA.required) {
      if (parsed[key] === undefined || parsed[key] === null) {
        throw new IntelligenceError(`Decision output missing required field: ${key}`, {
          code: 'AI_INVALID_OUTPUT',
          details: { key },
        });
      }
    }

    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new IntelligenceError('Decision confidence must be a number between 0 and 1', {
        code: 'AI_INVALID_OUTPUT',
      });
    }

    // Never accept fabricated historical IDs that are not in our store.
    const knownHistoryIds = new Set(helpers.historical.map((item) => item.id));
    const historicalRefs = Array.isArray(parsed.historicalRefs)
      ? parsed.historicalRefs.filter((ref) => {
          if (typeof ref === 'string') return knownHistoryIds.has(ref);
          if (ref && typeof ref === 'object' && ref.id) return knownHistoryIds.has(String(ref.id));
          return false;
        })
      : [];

    const evidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];
    const sanitizedEvidence = evidence.filter((item) => {
      if (!item || typeof item !== 'object') return true;
      if (item.type === 'historical' && item.id && !knownHistoryIds.has(String(item.id))) {
        return false;
      }
      return true;
    });

    return {
      decisionType: String(parsed.decisionType),
      objective: String(parsed.objective),
      selectedDecision: String(parsed.selectedDecision),
      reasoningSummary: String(parsed.reasoningSummary),
      confidence,
      evidence: sanitizedEvidence,
      historicalRefs,
      contextRefs: Array.isArray(parsed.contextRefs) && parsed.contextRefs.length
        ? parsed.contextRefs
        : helpers.contextVersionRefs,
      alternativesConsidered: Array.isArray(parsed.alternativesConsidered)
        ? parsed.alternativesConsidered
        : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks : [],
      missingInformation: Array.isArray(parsed.missingInformation)
        ? parsed.missingInformation
        : [],
      requiredPermissions: Array.isArray(parsed.requiredPermissions)
        ? parsed.requiredPermissions
        : [PermissionAction.ANALYZE, PermissionAction.CREATE_PLAN],
      expectedOutcome: String(parsed.expectedOutcome),
      prerequisites: Array.isArray(parsed.prerequisites) ? parsed.prerequisites : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
      proposedPlanSteps: Array.isArray(parsed.proposedPlanSteps)
        ? parsed.proposedPlanSteps
        : [],
    };
  }
}

/**
 * @param {string} text
 */
function extractJsonObject(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}
