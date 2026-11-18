import path from 'node:path';
import { IntelligenceError } from '../constants.js';
import { detectColumnMapping, mapRowToDecision } from './column-mapper.js';
import { readCsvFile } from './csv-importer.js';
import { readExcelFile } from './excel-importer.js';
import { validateImportBatch } from './import-validator.js';

export class ImportService {
  /**
   * @param {{
   *   historyRepository: import('./history-repository.js').HistoryRepository,
   *   auditService?: { record: Function } | null,
   * }} options
   */
  constructor(options) {
    this.historyRepository = options.historyRepository;
    this.auditService = options.auditService ?? null;
    /** @type {Map<string, { records: Array<Record<string, unknown>>, validation: ReturnType<typeof validateImportBatch> }>} */
    this._pending = new Map();
  }

  /**
   * Inspect a file without importing.
   *
   * @param {string} filePath
   * @param {{
   *   worksheet?: string,
   *   mapping?: Record<string, string>,
   *   previewLimit?: number,
   * }} [options]
   */
  preview(filePath, options = {}) {
    const inspected = this._readSource(filePath);
    const worksheet = this._selectWorksheet(inspected.worksheets, options.worksheet);
    const { mapping, unmappedHeaders } = detectColumnMapping(
      worksheet.headers,
      options.mapping ?? {},
    );
    const records = worksheet.rows.map((row) => mapRowToDecision(row, worksheet.headers, mapping));
    const validation = validateImportBatch(records);
    const previewLimit = Math.max(1, Math.min(Number(options.previewLimit ?? 10), 100));

    const batch = this.historyRepository.createBatch({
      sourcePath: path.resolve(filePath),
      sourceType: inspected.sourceType,
      worksheetName: worksheet.name,
      columnMapping: mapping,
      preview: records.slice(0, previewLimit),
      stats: {
        totalRows: records.length,
        validCount: validation.validCount,
        invalidCount: validation.invalid.length,
        incompleteCount: validation.incomplete.length,
        duplicateCount: validation.duplicates.length,
        unmappedHeaders,
        headers: worksheet.headers,
        worksheets: inspected.worksheets.map((sheet) => ({
          name: sheet.name,
          rowCount: sheet.rows.length,
          headers: sheet.headers,
        })),
      },
    });

    this._pending.set(batch.id, { records, validation });

    this.auditService?.record?.({
      entityType: 'import_batch',
      entityId: batch.id,
      eventType: 'import.preview',
      summary: `Previewed ${inspected.sourceType} import (${records.length} rows)`,
      payload: { sourcePath: batch.sourcePath, worksheet: worksheet.name },
      actor: 'owner',
    });

    return {
      batch,
      validation,
      unmappedHeaders,
      worksheets: inspected.worksheets.map((sheet) => ({
        name: sheet.name,
        rowCount: sheet.rows.length,
        headers: sheet.headers,
      })),
    };
  }

  /**
   * Confirm and persist a previously previewed batch.
   *
   * @param {string} batchId
   * @param {{ actor?: string, allowInvalid?: boolean }} [options]
   */
  confirm(batchId, options = {}) {
    const pending = this._pending.get(batchId);
    const batch = this.historyRepository.getBatch(batchId);
    if (!batch) {
      throw new IntelligenceError(`Import batch not found: ${batchId}`, {
        code: 'IMPORT_BATCH_NOT_FOUND',
      });
    }
    if (!pending) {
      throw new IntelligenceError(
        'Import preview expired or was created in another process. Run history import preview again.',
        { code: 'IMPORT_PREVIEW_EXPIRED' },
      );
    }

    if (!pending.validation.ok && !options.allowInvalid) {
      throw new IntelligenceError('Import validation failed. Re-run with --allow-invalid to force.', {
        code: 'IMPORT_VALIDATION_FAILED',
        details: {
          invalid: pending.validation.invalid,
          duplicates: pending.validation.duplicates,
        },
      });
    }

    const recordsToImport = options.allowInvalid
      ? pending.records
      : pending.records.filter((_, index) =>
          !pending.validation.invalid.some((item) => item.index === index));

    try {
      this.historyRepository.updateBatch(batchId, {
        status: 'CONFIRMED',
        confirmedBy: options.actor ?? 'owner',
        stats: {
          ...batch.stats,
          importedCount: recordsToImport.length,
        },
      });
      const ids = this.historyRepository.insertDecisions(batchId, recordsToImport);
      const updated = this.historyRepository.updateBatch(batchId, {
        status: 'IMPORTED',
        confirmedBy: options.actor ?? 'owner',
        stats: {
          ...batch.stats,
          importedCount: ids.length,
        },
      });
      this._pending.delete(batchId);
      this.auditService?.record?.({
        entityType: 'import_batch',
        entityId: batchId,
        eventType: 'import.confirmed',
        summary: `Imported ${ids.length} historical decisions`,
        payload: { importedCount: ids.length },
        actor: options.actor ?? 'owner',
      });
      return { batch: updated, importedIds: ids };
    } catch (error) {
      this.historyRepository.updateBatch(batchId, {
        status: 'FAILED',
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  /**
   * Preview + confirm in one step when --confirm is passed.
   *
   * @param {string} filePath
   * @param {{
   *   worksheet?: string,
   *   mapping?: Record<string, string>,
   *   actor?: string,
   *   allowInvalid?: boolean,
   *   confirm?: boolean,
   * }} [options]
   */
  importFile(filePath, options = {}) {
    const preview = this.preview(filePath, options);
    if (!options.confirm) {
      return { ...preview, imported: false };
    }
    const confirmed = this.confirm(preview.batch.id, {
      actor: options.actor,
      allowInvalid: options.allowInvalid,
    });
    return { ...preview, ...confirmed, imported: true };
  }

  /**
   * @param {{ query?: string, limit?: number, successStatus?: string }} [options]
   */
  search(options = {}) {
    return this.historyRepository.search(options);
  }

  /**
   * @param {string} filePath
   */
  _readSource(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.csv') {
      return readCsvFile(filePath);
    }
    if (ext === '.xlsx' || ext === '.xls') {
      return readExcelFile(filePath);
    }
    throw new IntelligenceError(
      `Unsupported import file type: ${ext || '(none)'}. Use .csv, .xlsx, or .xls`,
      { code: 'IMPORT_UNSUPPORTED_TYPE', details: { filePath } },
    );
  }

  /**
   * @param {Array<{ name: string, headers: string[], rows: Array<Record<string, unknown>> }>} worksheets
   * @param {string | undefined} preferred
   */
  _selectWorksheet(worksheets, preferred) {
    if (!worksheets.length) {
      throw new IntelligenceError('No worksheets found in source file', {
        code: 'IMPORT_NO_WORKSHEETS',
      });
    }
    if (preferred) {
      const match = worksheets.find(
        (sheet) => sheet.name.toLowerCase() === preferred.toLowerCase(),
      );
      if (!match) {
        throw new IntelligenceError(`Worksheet not found: ${preferred}`, {
          code: 'IMPORT_WORKSHEET_NOT_FOUND',
          details: { available: worksheets.map((sheet) => sheet.name) },
        });
      }
      return match;
    }
    const withRows = worksheets.find((sheet) => sheet.rows.length > 0) ?? worksheets[0];
    return withRows;
  }
}
