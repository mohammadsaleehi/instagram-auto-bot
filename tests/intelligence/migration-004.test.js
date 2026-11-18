import { describe, expect, it } from 'vitest';
import { Database } from '../../src/storage/database.js';

describe('Migration 004 intelligence', () => {
  it('applies intelligence tables', () => {
    const database = new Database({ filePath: ':memory:' });
    database.open();
    expect(database.getSchemaVersion()).toBeGreaterThanOrEqual(4);

    const tables = database.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'intelligence_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);

    expect(tables).toContain('intelligence_contexts');
    expect(tables).toContain('intelligence_context_versions');
    expect(tables).toContain('intelligence_historical_decisions');
    expect(tables).toContain('intelligence_decisions');
    expect(tables).toContain('intelligence_plans');
    expect(tables).toContain('intelligence_plan_steps');
    expect(tables).toContain('intelligence_audit_events');
    expect(tables).toContain('intelligence_ai_usage');
    database.close();
  });
});
