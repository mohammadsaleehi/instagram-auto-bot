import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { Database } from '../../src/storage/database.js';
import { createIntelligenceManager } from '../../src/intelligence/intelligence-manager.js';
import { MockProvider } from '../../src/intelligence/providers/mock/mock.provider.js';

describe('Intelligence historical import', () => {
  /** @type {Database[]} */
  const databases = [];
  /** @type {string[]} */
  const tempDirs = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const database = new Database({ filePath: ':memory:' });
    database.open();
    databases.push(database);
    return createIntelligenceManager({
      database,
      config: { aiProvider: 'mock' },
      provider: new MockProvider(),
    });
  }

  it('imports CSV with preview + confirm and supports search', () => {
    const ctx = setup();
    const csvPath = path.resolve('tests/fixtures/intelligence/sample-decisions.csv');
    const preview = ctx.importService.importFile(csvPath, { confirm: false });
    expect(preview.imported).toBe(false);
    expect(preview.batch.status).toBe('PREVIEW');
    expect(preview.validation.total).toBe(3);

    const confirmed = ctx.importService.confirm(preview.batch.id, { actor: 'owner' });
    expect(confirmed.importedIds).toHaveLength(3);

    const found = ctx.importService.search({ query: 'story' });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].raw).toBeTruthy();
  });

  it('imports Excel with multiple worksheets and maps columns', () => {
    const ctx = setup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-xlsx-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'decisions.xlsx');

    const workbook = XLSX.utils.book_new();
    const sheet1 = XLSX.utils.aoa_to_sheet([
      ['Decision', 'Date', 'Action Taken', 'Outcome', 'Success Status'],
      ['Test A', '2026-02-01', 'Did A', 'Worked', 'success'],
    ]);
    const sheet2 = XLSX.utils.aoa_to_sheet([
      ['Title', 'When', 'What was done', 'Result', 'Status'],
      ['Test B', '2026-02-02', 'Did B', 'Failed', 'failed'],
      ['', '2026-02-03', '', '', ''],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet1, 'Primary');
    XLSX.utils.book_append_sheet(workbook, sheet2, 'Secondary');
    XLSX.writeFile(workbook, filePath);

    const preview = ctx.importService.preview(filePath, { worksheet: 'Secondary' });
    expect(preview.worksheets).toHaveLength(2);
    expect(preview.validation.incomplete.length).toBeGreaterThan(0);

    const confirmed = ctx.importService.confirm(preview.batch.id, {
      actor: 'owner',
      allowInvalid: true,
    });
    expect(confirmed.importedIds.length).toBeGreaterThan(0);
  });

  it('detects duplicates', () => {
    const ctx = setup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-csv-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'dupes.csv');
    fs.writeFileSync(
      filePath,
      [
        'Decision,Date,Action Taken,Outcome,Success Status',
        'Same,2026-01-01,Act,Out,success',
        'Same,2026-01-01,Act,Out,success',
      ].join('\n'),
    );
    const preview = ctx.importService.preview(filePath);
    expect(preview.validation.duplicates.length).toBe(1);
  });
});
