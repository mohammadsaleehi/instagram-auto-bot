import {
  ApprovalStatus,
  INTELLIGENCE_EXECUTE_TASK_TYPE,
  IntelligenceError,
  PlanStatus,
  PlanStepStatus,
} from '../constants.js';

/**
 * Translates approved plan steps into Task Engine tasks.
 * Phase 1 only enqueues internal analysis/tool steps — never publishing.
 */
export class ExecutionController {
  /**
   * @param {{
   *   decisionRepository: import('./decision-repository.js').DecisionRepository,
   *   permissionService: import('../governance/permission-service.js').PermissionService,
   *   taskRepository?: import('../../storage/repositories/task-repository.js').TaskRepository | null,
   *   auditService?: import('../audit/audit-service.js').AuditService | null,
   * }} options
   */
  constructor(options) {
    this.decisionRepository = options.decisionRepository;
    this.permissionService = options.permissionService;
    this.taskRepository = options.taskRepository ?? null;
    this.auditService = options.auditService ?? null;
  }

  /**
   * @param {string} planId
   * @param {{ actor?: string }} [options]
   */
  prepareApprovedPlan(planId, options = {}) {
    const plan = this.decisionRepository.getPlan(planId);
    if (!plan) {
      throw new IntelligenceError(`Plan not found: ${planId}`, { code: 'PLAN_NOT_FOUND' });
    }
    if (plan.approvalStatus !== ApprovalStatus.APPROVED || plan.status !== PlanStatus.APPROVED) {
      throw new IntelligenceError('Plan is not approved for execution preparation', {
        code: 'PLAN_NOT_APPROVED',
      });
    }

    // External actions remain blocked in Phase 1 even if a plan mentions them.
    const blocked = plan.steps.filter((step) => isExternalStep(step));
    if (blocked.length > 0) {
      throw new IntelligenceError(
        'Phase 1 cannot execute external Instagram actions. Remove or defer publishing/messaging steps.',
        {
          code: 'PHASE1_EXTERNAL_ACTION_BLOCKED',
          details: { blockedStepIds: blocked.map((step) => step.id) },
        },
      );
    }

    /** @type {Array<{ stepId: string, taskId: string | null }>} */
    const enqueued = [];
    for (const step of plan.steps) {
      if (!this.taskRepository) {
        enqueued.push({ stepId: step.id, taskId: null });
        continue;
      }
      const created = this.taskRepository.create({
        type: INTELLIGENCE_EXECUTE_TASK_TYPE,
        payload: {
          planId: plan.id,
          stepId: step.id,
          toolName: step.toolName,
          inputs: step.inputs,
          title: step.title,
        },
        priority: 50,
        idempotencyKey: `intelligence:plan:${plan.id}:step:${step.id}`,
      });
      const task = created.task ?? created;
      this.databaseUpdateStepTask(step.id, task.id);
      enqueued.push({ stepId: step.id, taskId: task.id });
    }

    this.decisionRepository.updatePlanStatus(planId, {
      status: PlanStatus.READY,
      approvalStatus: ApprovalStatus.APPROVED,
    });

    this.auditService?.record?.({
      operationId: plan.operationId,
      entityType: 'plan',
      entityId: planId,
      eventType: 'plan.execution_prepared',
      summary: 'Approved plan prepared for internal task execution',
      payload: { enqueued },
      actor: options.actor ?? 'owner',
    });

    return {
      plan: this.decisionRepository.getPlan(planId),
      enqueued,
    };
  }

  /**
   * @param {string} stepId
   * @param {string} taskId
   */
  databaseUpdateStepTask(stepId, taskId) {
    this.decisionRepository.database.raw
      .prepare(
        `UPDATE intelligence_plan_steps
         SET task_id = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(taskId, PlanStepStatus.READY, new Date().toISOString(), stepId);
  }
}

/**
 * @param {any} step
 */
function isExternalStep(step) {
  const text = `${step.title ?? ''} ${step.description ?? ''} ${step.toolName ?? ''}`.toLowerCase();
  return /publish|send message|discount|change price|change budget|delete published/.test(text);
}
