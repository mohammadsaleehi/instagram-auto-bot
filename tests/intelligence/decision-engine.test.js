import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../../src/storage/database.js';
import { createIntelligenceManager } from '../../src/intelligence/intelligence-manager.js';
import { ContextKind, IntelligenceError } from '../../src/intelligence/constants.js';
import { MockProvider } from '../../src/intelligence/providers/mock/mock.provider.js';
import { parseInstruction } from '../../src/intelligence/agent/instruction-parser.js';

describe('Instruction parser and decision engine', () => {
  /** @type {Database[]} */
  const databases = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function setup(provider = new MockProvider()) {
    const database = new Database({ filePath: ':memory:' });
    database.open();
    databases.push(database);
    return {
      database,
      ...createIntelligenceManager({
        database,
        config: { aiProvider: 'mock', aiMaxToolIterations: 4 },
        provider,
      }),
    };
  }

  function registerContexts(ctx) {
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
  }

  it('parses analysis instructions and flags ambiguities', () => {
    const parsed = parseInstruction(
      'Analyze why Story performance decreased compared to the previous week.',
    );
    expect(parsed.type).toBe('performance_analysis');
    expect(parsed.target).toBe('stories');
    expect(parsed.period?.current).toBe('last_7_days');
    expect(parsed.requestedOutput).toContain('analysis');
  });

  it('requests clarification when context is missing instead of inventing it', async () => {
    const ctx = setup();
    const result = await ctx.service.execute(
      'Analyze the account\'s content performance and generate an operational plan',
    );
    expect(result.status).toBe('needs_clarification');
    expect(result.decision).toBeNull();
    expect(result.parsed.missingPrerequisites.length).toBeGreaterThan(0);
  });

  it('creates a decision with evidence references and a plan', async () => {
    const ctx = setup();
    registerContexts(ctx);
    const imported = ctx.importService.importFile(
      path.resolve('tests/fixtures/intelligence/sample-decisions.csv'),
      { confirm: true },
    );
    expect(imported.importedIds.length).toBe(3);

    const result = await ctx.service.execute(
      'Analyze the account\'s content performance, compare it with historical decisions, identify what has worked, and generate an operational plan consistent with the current business strategy.',
    );

    expect(result.status).toBe('plan_pending_approval');
    expect(result.isMock).toBe(true);
    expect(result.decision.reasoningSummary).toBeTruthy();
    expect(result.decision.provider).toBe('mock');
    expect(result.plan.steps.length).toBeGreaterThan(0);
    expect(result.decision.rawResponse.isMock).toBe(true);
  });

  it('does not persist a successful decision when provider fails', async () => {
    const provider = new MockProvider({
      failWith: new IntelligenceError('provider down', { code: 'OPENROUTER_UNAVAILABLE' }),
    });
    const ctx = setup(provider);
    registerContexts(ctx);

    await expect(
      ctx.service.execute('Analyze Story performance for the last 7 days and create a plan'),
    ).rejects.toThrow(/provider down/i);

    expect(ctx.service.listDecisions()).toHaveLength(0);
  });

  it('rejects malformed decision JSON', async () => {
    const provider = new MockProvider({
      responses: [
        {
          provider: 'mock',
          modelRequested: 'mock/deterministic',
          modelUsed: 'mock/deterministic',
          content: 'not-json',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: null },
          durationMs: 1,
          isMock: true,
        },
      ],
    });
    const ctx = setup(provider);
    registerContexts(ctx);
    await expect(
      ctx.service.execute('Analyze content performance and generate a plan'),
    ).rejects.toThrow(/malformed JSON/i);
  });
});
