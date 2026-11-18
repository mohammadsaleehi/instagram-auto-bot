import {
  ApprovalStatus,
  IntelligenceError,
  PermissionAction,
  PlanStatus,
} from '../constants.js';

export class PlanningEngine {
  /**
   * @param {{
   *   decisionRepository: import('./decision-repository.js').DecisionRepository,
   *   permissionService: import('../governance/permission-service.js').PermissionService,
   *   auditService?: import('../audit/audit-service.js').AuditService | null,
   * }} options
   */
  constructor(options) {
    this.decisionRepository = options.decisionRepository;
    this.permissionService = options.permissionService;
    this.auditService = options.auditService ?? null;
  }

  /**
   * @param {{
   *   decision: any,
   *   proposedPlanSteps?: any[],
   *   instruction: any,
   * }} input
   */
  createPlan(input) {
    this.permissionService.assertAllowed(PermissionAction.CREATE_PLAN, { actor: 'system' });

    const steps = normalizeSteps(input.proposedPlanSteps, input.decision, input.instruction);
    if (steps.length === 0) {
      throw new IntelligenceError('Cannot create an empty execution plan', {
        code: 'PLAN_EMPTY',
      });
    }

    const requiredPermissions = [
      ...new Set([
        ...(input.decision.requiredPermissions ?? []),
        PermissionAction.CREATE_PLAN,
      ]),
    ];

    const approvalNeeded = requiredPermissions.some(
      (action) => this.permissionService.inspect(action).approvalRequired,
    ) || steps.some((step) => isExternalAction(step));

    const plan = this.decisionRepository.createPlan({
      decisionId: input.decision.id,
      instructionId: input.decision.instructionId,
      operationId: input.decision.operationId,
      status: PlanStatus.PENDING_APPROVAL,
      objective: input.decision.objective,
      selectedDecision: input.decision.selectedDecision,
      riskLevel: estimateRisk(steps, input.decision),
      requiredPermissions,
      approvalRequired: true,
      approvalStatus: ApprovalStatus.PENDING,
      prerequisites: input.decision.prerequisites ?? [],
      steps,
    });

    this.auditService?.record?.({
      operationId: input.decision.operationId,
      entityType: 'plan',
      entityId: plan.id,
      eventType: 'plan.created',
      summary: `Created execution plan with ${steps.length} steps`,
      payload: {
        approvalRequired: true,
        approvalNeeded,
        stepCount: steps.length,
      },
      actor: 'system',
    });

    return plan;
  }
}

/**
 * @param {any[]} proposed
 * @param {any} decision
 * @param {any} instruction
 */
function normalizeSteps(proposed, decision, instruction) {
  if (Array.isArray(proposed) && proposed.length > 0) {
    return proposed.map((step, index) => ({
      title: String(step.title ?? `Step ${index + 1}`),
      description: String(step.description ?? ''),
      toolName: step.toolName ? String(step.toolName) : null,
      inputs: step.inputs && typeof step.inputs === 'object' ? step.inputs : {},
      expectedOutput: String(step.expectedOutput ?? ''),
      prerequisites: Array.isArray(step.prerequisites) ? step.prerequisites : [],
    }));
  }

  return [
    {
      title: 'Retrieve active business context',
      description: 'Load brand, business, and strategy context versions used for this decision.',
      toolName: 'get_business_context',
      inputs: {},
      expectedOutput: 'Context bundle with version references',
      prerequisites: [],
    },
    {
      title: 'Retrieve relevant historical decisions',
      description: 'Search imported historical decisions related to the instruction target.',
      toolName: 'search_historical_decisions',
      inputs: {
        query: instruction?.parsed?.target || 'performance',
        limit: 25,
      },
      expectedOutput: 'Searchable historical decision records',
      prerequisites: [],
    },
    {
      title: 'Analyze evidence and previous outcomes',
      description: decision.reasoningSummary || 'Analyze available evidence without fabricating metrics.',
      toolName: null,
      inputs: {},
      expectedOutput: 'Evidence-based conclusions and limitations',
      prerequisites: [],
    },
    {
      title: 'Select authorized operational approach',
      description: decision.selectedDecision,
      toolName: null,
      inputs: {},
      expectedOutput: 'Authorized operational decision',
      prerequisites: [],
    },
    {
      title: 'Submit plan for owner approval',
      description: 'No external Instagram action will run until the owner approves.',
      toolName: null,
      inputs: {},
      expectedOutput: 'Owner approval or rejection',
      prerequisites: [],
    },
  ];
}

/**
 * @param {any} step
 */
function isExternalAction(step) {
  const text = `${step.title ?? ''} ${step.description ?? ''} ${step.toolName ?? ''}`.toLowerCase();
  return /publish|message|discount|price|budget|delete/.test(text);
}

/**
 * @param {any[]} steps
 * @param {any} decision
 */
function estimateRisk(steps, decision) {
  if (steps.some(isExternalAction)) return 'high';
  if ((decision.confidence ?? 1) < 0.4) return 'high';
  if ((decision.missingInformation ?? []).length > 2) return 'medium';
  return 'low';
}
