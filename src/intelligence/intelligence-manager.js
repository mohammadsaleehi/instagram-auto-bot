import { INTELLIGENCE_EXECUTE_TASK_TYPE } from './constants.js';
import { AuditService } from './audit/audit-service.js';
import { ContextRepository } from './context/context-repository.js';
import { ContextService } from './context/context-service.js';
import { HistoryRepository } from './import/history-repository.js';
import { ImportService } from './import/import-service.js';
import { AgentRuntime } from './agent/agent-runtime.js';
import { DecisionEngine } from './agent/decision-engine.js';
import { DecisionRepository } from './agent/decision-repository.js';
import { ExecutionController } from './agent/execution-controller.js';
import { PlanningEngine } from './agent/planning-engine.js';
import { createDefaultToolRegistry } from './agent/tool-registry.js';
import { DecisionEvaluator } from './evaluation/decision-evaluator.js';
import { PermissionService } from './governance/permission-service.js';
import { createAiProvider } from './providers/provider.factory.js';

/**
 * Factory that wires the Intelligence Core for Application / CLI.
 *
 * @param {{
 *   database: import('../storage/database.js').Database,
 *   config?: Record<string, unknown>,
 *   taskRepository?: import('../storage/repositories/task-repository.js').TaskRepository | null,
 *   logger?: { info?: Function, warn?: Function, error?: Function, debug?: Function } | null,
 *   provider?: any,
 *   nowFn?: () => Date,
 *   idFn?: () => string,
 *   OpenAIClass?: any,
 * }} options
 */
export function createIntelligenceManager(options) {
  const config = options.config ?? {};
  const auditService = new AuditService(options.database, {
    nowFn: options.nowFn,
    idFn: options.idFn,
  });
  const contextRepository = new ContextRepository(options.database, {
    nowFn: options.nowFn,
    idFn: options.idFn,
  });
  const contextService = new ContextService({
    repository: contextRepository,
    auditService,
  });
  const historyRepository = new HistoryRepository(options.database, {
    nowFn: options.nowFn,
    idFn: options.idFn,
  });
  const importService = new ImportService({
    historyRepository,
    auditService,
  });
  const decisionRepository = new DecisionRepository(options.database, {
    nowFn: options.nowFn,
    idFn: options.idFn,
  });
  const permissionService = new PermissionService({
    database: options.database,
    nowFn: options.nowFn,
    idFn: options.idFn,
  });
  const provider =
    options.provider ??
    createAiProvider(config, {
      logger: options.logger,
      OpenAIClass: options.OpenAIClass,
    });
  const toolRegistry = createDefaultToolRegistry({
    contextService,
    importService,
    historyRepository,
  });
  const decisionEngine = new DecisionEngine({
    provider,
    toolRegistry,
    permissionService,
    contextService,
    importService,
    decisionRepository,
    auditService,
    maxToolIterations: Number(config.aiMaxToolIterations ?? 8),
  });
  const planningEngine = new PlanningEngine({
    decisionRepository,
    permissionService,
    auditService,
  });
  const evaluator = new DecisionEvaluator({
    database: options.database,
    decisionRepository,
    historyRepository,
    auditService,
    nowFn: options.nowFn,
    idFn: options.idFn,
  });
  const executionController = new ExecutionController({
    decisionRepository,
    permissionService,
    taskRepository: options.taskRepository ?? null,
    auditService,
  });
  const runtime = new AgentRuntime({
    contextService,
    importService,
    decisionEngine,
    planningEngine,
    decisionRepository,
    permissionService,
    auditService,
    evaluator,
    executionController,
    provider,
    idFn: options.idFn,
  });

  const executeHandler = Object.freeze({
    type: INTELLIGENCE_EXECUTE_TASK_TYPE,
    description: 'Execute an approved internal intelligence plan step',
    requiresAuth: false,
    externalSideEffect: false,
    /**
     * @param {any} context
     * @param {any} payload
     */
    async execute(context, payload) {
      context.logger?.info?.('Intelligence plan step acknowledged', {
        planId: payload?.planId,
        stepId: payload?.stepId,
        toolName: payload?.toolName,
      });
      // Phase 1 foundation: steps are recorded/queued; external actions stay blocked.
      return {
        ok: true,
        phase: 1,
        planId: payload?.planId ?? null,
        stepId: payload?.stepId ?? null,
        toolName: payload?.toolName ?? null,
        note: 'Internal intelligence step accepted. External Instagram actions remain disabled in Phase 1.',
      };
    },
  });

  return {
    auditService,
    contextRepository,
    contextService,
    historyRepository,
    importService,
    decisionRepository,
    permissionService,
    provider,
    toolRegistry,
    decisionEngine,
    planningEngine,
    evaluator,
    executionController,
    runtime,
    service: runtime,
    executeHandler,
  };
}
