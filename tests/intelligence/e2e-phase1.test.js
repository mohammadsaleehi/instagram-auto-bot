import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../../src/storage/database.js';
import { createIntelligenceManager } from '../../src/intelligence/intelligence-manager.js';
import { ContextKind } from '../../src/intelligence/constants.js';
import { MockProvider } from '../../src/intelligence/providers/mock/mock.provider.js';

describe('Phase 1 mandatory end-to-end scenario (MockProvider)', () => {
  /** @type {Database[]} */
  const databases = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('registers context, imports history, executes, approves, and persists audit trail', async () => {
    const database = new Database({ filePath: ':memory:' });
    database.open();
    databases.push(database);

    const manager = createIntelligenceManager({
      database,
      config: {
        aiProvider: 'mock',
        openrouterModel: null,
      },
      provider: new MockProvider(),
    });

    // Step 1 — register business context
    manager.contextService.register({
      kind: ContextKind.BRAND,
      name: 'Demo Brand',
      payload: JSON.parse(
        fs.readFileSync(path.resolve('tests/fixtures/intelligence/sample-context.json'), 'utf8'),
      ).payload,
    });
    manager.contextService.register({
      kind: ContextKind.BUSINESS,
      name: 'Demo Business',
      payload: JSON.parse(
        fs.readFileSync(path.resolve('tests/fixtures/intelligence/sample-business.json'), 'utf8'),
      ).payload,
    });
    manager.contextService.register({
      kind: ContextKind.STRATEGY,
      name: 'Demo Strategy',
      payload: JSON.parse(
        fs.readFileSync(path.resolve('tests/fixtures/intelligence/sample-strategy.json'), 'utf8'),
      ).payload,
    });

    // Step 2 — import historical decisions
    const imported = manager.importService.importFile(
      path.resolve('tests/fixtures/intelligence/sample-decisions.csv'),
      { confirm: true, actor: 'owner' },
    );
    expect(imported.imported).toBe(true);
    expect(manager.importService.search({ query: 'story' }).length).toBeGreaterThan(0);

    // Step 3/4 — submit command and process
    const result = await manager.service.execute(
      'Analyze the account\'s content performance, compare it with historical decisions, identify what has worked, and generate an operational plan consistent with the current business strategy.',
    );

    expect(result.status).toBe('plan_pending_approval');
    expect(result.isMock).toBe(true);
    expect(result.decision).toBeTruthy();
    expect(result.plan).toBeTruthy();
    expect(result.decision.contextVersionRefs.length).toBeGreaterThan(0);
    expect(result.decision.reasoningSummary).toBeTruthy();

    // Step 5 — owner review
    const approved = manager.service.approvePlan(result.plan.id, {
      actor: 'owner',
      note: 'Approved for internal follow-up only',
    });
    expect(approved.plan.approvalStatus).toBe('APPROVED');

    // Step 6 — persistence verification
    expect(manager.service.getDecision(result.decision.id).id).toBe(result.decision.id);
    expect(manager.service.getPlan(result.plan.id).id).toBe(result.plan.id);
    const audit = manager.auditService.list({ operationId: result.operationId });
    expect(audit.some((event) => event.eventType === 'instruction.received')).toBe(true);
    expect(audit.some((event) => event.eventType === 'decision.created')).toBe(true);
    expect(audit.some((event) => event.eventType === 'plan.created')).toBe(true);
    expect(audit.some((event) => event.eventType === 'plan.approved')).toBe(true);

    const usage = manager.service.aiUsage();
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0].provider).toBe('mock');
  });
});
