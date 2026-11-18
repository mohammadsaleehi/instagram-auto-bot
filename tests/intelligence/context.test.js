import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/storage/database.js';
import { createIntelligenceManager } from '../../src/intelligence/intelligence-manager.js';
import { ContextKind } from '../../src/intelligence/constants.js';
import { MockProvider } from '../../src/intelligence/providers/mock/mock.provider.js';

describe('Intelligence context management', () => {
  /** @type {Database[]} */
  const databases = [];

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close();
    }
  });

  function setup() {
    const database = new Database({ filePath: ':memory:' });
    database.open();
    databases.push(database);
    const manager = createIntelligenceManager({
      database,
      config: { aiProvider: 'mock' },
      provider: new MockProvider(),
    });
    return { database, ...manager };
  }

  it('creates, updates, retrieves, and versions context', () => {
    const ctx = setup();
    const created = ctx.contextService.register({
      kind: ContextKind.BRAND,
      name: 'Brand',
      payload: {
        brandName: 'Acme',
        businessCategory: 'Retail',
        brandDescription: 'Test brand',
      },
    });

    expect(created.currentVersion).toBe(1);
    expect(created.payload.brandName).toBe('Acme');

    const updated = ctx.contextService.update(created.id, {
      payload: {
        brandName: 'Acme',
        businessCategory: 'Retail',
        brandDescription: 'Updated description',
        brandRestrictions: ['no fake claims'],
      },
      changeSummary: 'Updated description',
    });
    expect(updated.currentVersion).toBe(2);

    const versions = ctx.contextService.listVersions(created.id);
    expect(versions).toHaveLength(2);
    expect(ctx.contextService.get(created.id)?.payload.brandDescription).toBe(
      'Updated description',
    );
    expect(ctx.contextService.list({ kind: ContextKind.BRAND })).toHaveLength(1);
  });

  it('rejects invalid brand payloads', () => {
    const ctx = setup();
    expect(() =>
      ctx.contextService.register({
        kind: ContextKind.BRAND,
        payload: { businessCategory: 'Retail' },
      }),
    ).toThrow(/missing required fields/i);
  });
});
