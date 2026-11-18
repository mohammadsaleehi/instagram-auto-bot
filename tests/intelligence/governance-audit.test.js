import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../../src/storage/database.js';
import { TaskRepository } from '../../src/storage/repositories/task-repository.js';
import { createIntelligenceManager } from '../../src/intelligence/intelligence-manager.js';
import {
  ContextKind,
  PermissionAction,
  PlanStatus,
} from '../../src/intelligence/constants.js';
import { MockProvider } from '../../src/intelligence/providers/mock/mock.provider.js';

describe('Governance, audit, evaluation, and plan approvals', () => {
  /** @type {Database[]} */
  const databases = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function setup() {
    const database = new Database({ filePath: ':memory:' });
    database.open();
    databases.push(database);
    const taskRepository = new TaskRepository(database);
    return {
      database,
      taskRepository,
      ...createIntelligenceManager({
        database,
        config: { aiProvider: 'mock' },
        provider: new MockProvider(),
        taskRepository,
      }),
    };
  }

  async function seedAndExecute(ctx) {
    ctx.contextService.register({
      kind: ContextKind.BRAND,
      payload: JSON.parse(
        fs.readFileSync(path.resolve('tests/fixtures/intelligence/sample-context.json'), 'utf8'),
      ).payload,
    });
    ctx.contextService.register({
      kind: ContextKind.BUSINESS,
      payload: JSON.parse(
        fs.readFileSync(path.resolve('tests/fixtures/intelligence/sample-business.json'), 'utf8'),
      ).payload,
    });
    ctx.contextService.register({
      kind: ContextKind.STRATEGY,
      payload: JSON.parse(
        fs.readFileSync(path.resolve('tests/fixtures/intelligence/sample-strategy.json'), 'utf8'),
      ).payload,
    });
    ctx.importService.importFile(
      path.resolve('tests/fixtures/intelligence/sample-decisions.csv'),
      { confirm: true },
    );
    return ctx.service.execute(
      'Analyze content performance using historical decisions and generate an operational plan',
    );
  }

  it('allows analysis and blocks unauthorized external actions without approval', () => {
    const ctx = setup();
    expect(ctx.permissionService.inspect(PermissionAction.ANALYZE).approvalRequired).toBe(false);
    expect(ctx.permissionService.inspect(PermissionAction.PUBLISH_CONTENT).approvalRequired).toBe(
      true,
    );
    expect(() =>
      ctx.permissionService.assertAllowed(PermissionAction.PUBLISH_CONTENT, { actor: 'system' }),
    ).toThrow(/approval/i);
  });

  it('supports plan approve/reject and persists audit events', async () => {
    const ctx = setup();
    const executed = await seedAndExecute(ctx);
    const approved = ctx.service.approvePlan(executed.plan.id, {
      actor: 'owner',
      note: 'Looks good',
      prepareExecution: true,
    });
    expect(approved.plan.status).toBe(PlanStatus.READY);
    expect(approved.prepared.enqueued.length).toBeGreaterThan(0);

    const events = ctx.auditService.list({ operationId: executed.operationId });
    expect(events.some((event) => event.eventType === 'decision.created')).toBe(true);
    expect(events.some((event) => event.eventType === 'plan.approved')).toBe(true);

    const second = await seedAndExecute(ctx);
    const rejected = ctx.service.rejectPlan(second.plan.id, {
      actor: 'owner',
      note: 'Not now',
    });
    expect(rejected.plan.status).toBe(PlanStatus.REJECTED);
  });

  it('evaluates decisions without mutating strategy autonomously', async () => {
    const ctx = setup();
    const executed = await seedAndExecute(ctx);
    const evaluation = ctx.evaluator.evaluate(executed.decision.id, {
      outcomeSummary: 'Partial success with remaining gaps',
    });
    expect(evaluation.requiresOwnerApproval).toBe(true);
    expect(evaluation.improvementRecommendations.length).toBeGreaterThan(0);
    expect(ctx.evaluator.listForDecision(executed.decision.id)).toHaveLength(1);
  });
});
