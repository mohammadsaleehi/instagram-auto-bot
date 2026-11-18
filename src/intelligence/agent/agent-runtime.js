import { randomUUID } from 'node:crypto';
import {
  ApprovalStatus,
  IntelligenceError,
  InstructionStatus,
  PlanStatus,
} from '../constants.js';
import { parseInstruction } from './instruction-parser.js';

export class AgentRuntime {
  /**
   * @param {{
   *   contextService: import('../context/context-service.js').ContextService,
   *   importService: import('../import/import-service.js').ImportService,
   *   decisionEngine: import('./decision-engine.js').DecisionEngine,
   *   planningEngine: import('./planning-engine.js').PlanningEngine,
   *   decisionRepository: import('./decision-repository.js').DecisionRepository,
   *   permissionService: import('../governance/permission-service.js').PermissionService,
   *   auditService: import('../audit/audit-service.js').AuditService,
   *   evaluator: import('../evaluation/decision-evaluator.js').DecisionEvaluator,
   *   executionController: import('./execution-controller.js').ExecutionController,
   *   provider: { getStatus: Function, testConnection?: Function, listModels?: Function, isMock?: boolean, name: string },
   *   idFn?: () => string,
   * }} options
   */
  constructor(options) {
    this.contextService = options.contextService;
    this.importService = options.importService;
    this.decisionEngine = options.decisionEngine;
    this.planningEngine = options.planningEngine;
    this.decisionRepository = options.decisionRepository;
    this.permissionService = options.permissionService;
    this.auditService = options.auditService;
    this.evaluator = options.evaluator;
    this.executionController = options.executionController;
    this.provider = options.provider;
    this.idFn = options.idFn ?? (() => randomUUID());
  }

  /**
   * Full Phase 1 command workflow: parse → decide → plan.
   *
   * @param {string} rawText
   * @param {{ signal?: AbortSignal, actor?: string }} [options]
   */
  async execute(rawText, options = {}) {
    const operationId = this.idFn();
    this.auditService.record({
      operationId,
      entityType: 'instruction',
      eventType: 'instruction.received',
      summary: 'Received owner command',
      payload: { length: String(rawText ?? '').length },
      actor: options.actor ?? 'owner',
    });

    const availability = this.contextService.getRelevantBusinessContext();
    const parsed = parseInstruction(rawText, {
      hasBrand: availability.hasBrand,
      hasBusiness: availability.hasBusiness,
      hasStrategy: availability.hasStrategy,
    });

    const instruction = this.decisionRepository.createInstruction({
      operationId,
      rawText: String(rawText ?? ''),
      status:
        parsed.missingPrerequisites.length > 0
          ? InstructionStatus.NEEDS_CLARIFICATION
          : InstructionStatus.PARSED,
      parsed,
      ambiguities: parsed.ambiguities,
      missingPrerequisites: parsed.missingPrerequisites,
      requiredPermissions: parsed.requiredPermissions,
    });

    if (parsed.missingPrerequisites.length > 0) {
      this.auditService.record({
        operationId,
        entityType: 'instruction',
        entityId: instruction.id,
        eventType: 'instruction.needs_clarification',
        summary: 'Missing prerequisites prevent decision-making',
        payload: {
          missingPrerequisites: parsed.missingPrerequisites,
          ambiguities: parsed.ambiguities,
        },
        actor: options.actor ?? 'owner',
      });
      return {
        operationId,
        status: 'needs_clarification',
        instruction,
        parsed,
        decision: null,
        plan: null,
        isMock: Boolean(this.provider.isMock),
      };
    }

    const decided = await this.decisionEngine.decide({
      instructionRecord: instruction,
      parsed,
      operationId,
      signal: options.signal,
    });

    const plan = this.planningEngine.createPlan({
      decision: decided.decision,
      proposedPlanSteps: decided.proposedPlanSteps,
      instruction,
    });

    return {
      operationId,
      status: 'plan_pending_approval',
      instruction: this.decisionRepository.getInstruction(instruction.id),
      parsed,
      decision: decided.decision,
      plan,
      toolTrace: decided.toolTrace,
      isMock: decided.isMock,
    };
  }

  /**
   * Analysis-only helper that still goes through the same decision path.
   *
   * @param {{ signal?: AbortSignal, actor?: string }} [options]
   */
  async analyze(options = {}) {
    return this.execute(
      'Analyze the account\'s content performance, compare it with historical decisions, identify what has worked, and generate an operational plan consistent with the current business strategy.',
      options,
    );
  }

  listDecisions(limit = 50) {
    return this.decisionRepository.listDecisions(limit);
  }

  getDecision(id) {
    const decision = this.decisionRepository.getDecision(id);
    if (!decision) {
      throw new IntelligenceError(`Decision not found: ${id}`, { code: 'DECISION_NOT_FOUND' });
    }
    return decision;
  }

  listPlans(limit = 50) {
    return this.decisionRepository.listPlans(limit);
  }

  getPlan(id) {
    const plan = this.decisionRepository.getPlan(id);
    if (!plan) {
      throw new IntelligenceError(`Plan not found: ${id}`, { code: 'PLAN_NOT_FOUND' });
    }
    return plan;
  }

  /**
   * @param {string} planId
   * @param {{ actor?: string, note?: string, prepareExecution?: boolean }} [options]
   */
  approvePlan(planId, options = {}) {
    const plan = this.getPlan(planId);
    const approval = this.permissionService.approve({
      entityType: 'plan',
      entityId: planId,
      actor: options.actor ?? 'owner',
      note: options.note ?? '',
    });
    const updated = this.decisionRepository.updatePlanStatus(planId, {
      status: PlanStatus.APPROVED,
      approvalStatus: ApprovalStatus.APPROVED,
    });
    this.auditService.record({
      operationId: plan.operationId,
      entityType: 'plan',
      entityId: planId,
      eventType: 'plan.approved',
      summary: 'Owner approved execution plan',
      payload: { approvalId: approval.id },
      actor: options.actor ?? 'owner',
    });

    let prepared = null;
    if (options.prepareExecution) {
      prepared = this.executionController.prepareApprovedPlan(planId, {
        actor: options.actor ?? 'owner',
      });
    }

    return {
      plan: prepared?.plan ?? updated,
      approval,
      prepared,
    };
  }

  /**
   * @param {string} planId
   * @param {{ actor?: string, note?: string }} [options]
   */
  rejectPlan(planId, options = {}) {
    const plan = this.getPlan(planId);
    const approval = this.permissionService.reject({
      entityType: 'plan',
      entityId: planId,
      actor: options.actor ?? 'owner',
      note: options.note ?? '',
    });
    const updated = this.decisionRepository.updatePlanStatus(planId, {
      status: PlanStatus.REJECTED,
      approvalStatus: ApprovalStatus.REJECTED,
    });
    this.auditService.record({
      operationId: plan.operationId,
      entityType: 'plan',
      entityId: planId,
      eventType: 'plan.rejected',
      summary: 'Owner rejected execution plan',
      payload: { approvalId: approval.id },
      actor: options.actor ?? 'owner',
    });
    return { plan: updated, approval };
  }

  aiStatus() {
    return this.provider.getStatus();
  }

  async aiTest() {
    if (typeof this.provider.testConnection !== 'function') {
      throw new IntelligenceError('Provider does not support connection tests', {
        code: 'AI_TEST_UNSUPPORTED',
      });
    }
    return this.provider.testConnection();
  }

  async aiModels() {
    if (typeof this.provider.listModels !== 'function') {
      return {
        configured: this.provider.getStatus(),
        models: [],
      };
    }
    const models = await this.provider.listModels();
    return {
      configured: this.provider.getStatus(),
      models,
    };
  }

  aiUsage(limit = 50) {
    return this.decisionRepository.listUsage(limit);
  }
}
